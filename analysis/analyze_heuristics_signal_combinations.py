"""analysis/analyze_heuristics_signal_combinations.py

TECH_*シグナルを複数（3個以上も含む）組み合わせたAND条件について、
Apriori風のレベルワイズ探索でルールマイニングを行い、
単独指標と同じ考え方（pooled Mann-Whitney U検定 + FDR補正）で
統計的優位性を検証する。

# なぜ「Apriori風」の探索が必要か
40種類超のTECH_*から素朴に全組み合わせを列挙すると、3個の組み合わせだけで
40C3≈9,880通り、4個で≈91,390通りとなり、現実的な実行時間に収まらない上、
多重検定の母数が爆発し統計的検出力を失う。
Apriori（頻出パターンマイニングの古典的アルゴリズム）の
「アンチモノトーン性（ある組み合わせがmin_support未満なら、それを含む
より大きな組み合わせも必ずmin_support未満になる）」を利用し、
レベルワイズに候補を絞り込みながら探索することで、組み合わせ数の爆発を
実務的な範囲に抑える。

# 新規ライブラリについて
Apriori自体は自前実装も可能だが、頻出パターン抽出は
mlxtend.frequent_patterns.apriori が広く使われる標準的な実装であり、
自前実装するよりバグ混入リスクが低く可読性も高いため採用する
（analysis/requirements.txt に mlxtend を追加。backend/scriptsの
既存依存には影響しない、analysis専用の追加）。

run_all.py から呼ぶ場合も、本ファイル単体で実行する場合も、
データの読み込みは1回で済むようこの関数にロジックを切り出している
（analyze_heuristics_signals.py・analyze_heuristics_signals_daywise.py と同じ方針）。
"""
import sys
from pathlib import Path

import pandas as pd
from mlxtend.frequent_patterns import apriori
from scipy.stats import mannwhitneyu
from statsmodels.stats.multitest import multipletests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common.tech_rules import classify
from common.cli import parse_date_range
from common.repo_data import load_price_series, load_heuristics
from analyze_heuristics_signals import build_long_df, HORIZONS

# 以下3定数はいずれも初期値（推測値）。実データでの試行結果を見ながら調整する想定。
MIN_SUPPORT = 0.02      # 全観測のうちその組み合わせがsignalになる割合の下限（探索対象の足切り）
MAX_ITEMSET_SIZE = 4    # 組み合わせの最大個数（4を超えるとmlxtend側の探索コストが急増するため）
MIN_SAMPLE_SIZE = 30    # 単独検定（analyze_heuristics_signals.py）の最小サンプル数30件と揃えている


def _classify_matrix(sub: pd.DataFrame, tech_cols: list[str]) -> pd.DataFrame:
    """各TECH_*列を signal/baseline/skip に分類した文字列DataFrameを作る（1回だけ計算し使い回す）。"""
    return pd.DataFrame({col: sub[col].apply(classify) for col in tech_cols})


def _frequent_itemsets(signal_matrix: pd.DataFrame) -> pd.DataFrame:
    """mlxtend.apriori で min_support 以上の頻出組み合わせ（サイズ2〜MAX_ITEMSET_SIZE）を抽出する。"""
    itemsets = apriori(signal_matrix, min_support=MIN_SUPPORT, max_len=MAX_ITEMSET_SIZE, use_colnames=True)
    itemsets["size"] = itemsets["itemsets"].apply(len)
    return itemsets[itemsets["size"] >= 2].sort_values("size")


def run_combination_test(price: dict, trading_dates: list, heur: dict) -> pd.DataFrame:
    """複数TECH_*の組み合わせ（AND条件）について、Apriori風探索とpooled検定を組み合わせて実行する。

    単独検定（analyze_heuristics_signals.run_pooled_test）と同じ long形式データを再利用し、
    horizon（1・3・5営業日）ごとに集計する。
    「シグナルあり」＝組み合わせ内の全キーがsignal判定、
    「ベースライン」＝組み合わせ内の全キーがbaseline判定の行とし、
    signal/baseline/skipが混在する行は単独検定同様に対象外とする
    （common.tech_rules.classify() の「分類不能な値は誤ったシグナル混入を避けるため
    明示的に対象外とする」方針をそのまま踏襲）。
    """
    df = build_long_df(price, trading_dates, heur)
    tech_cols = [c for c in df.columns if c.startswith("TECH_")]

    results = []
    for horizon in HORIZONS:
        sub = df[df["horizon"] == horizon].reset_index(drop=True)
        cls_matrix = _classify_matrix(sub, tech_cols)
        signal_matrix = (cls_matrix == "signal")

        frequent = _frequent_itemsets(signal_matrix)
        print(f"horizon={horizon}: min_support={MIN_SUPPORT}以上の組み合わせ候補 {len(frequent)}件")

        for _, row in frequent.iterrows():
            keys = sorted(row["itemsets"])
            combined_signal = signal_matrix[keys].all(axis=1)
            combined_baseline = (cls_matrix[keys] == "baseline").all(axis=1)

            signaled = sub.loc[combined_signal, "fwd_return"].dropna()
            baseline = sub.loc[combined_baseline, "fwd_return"].dropna()
            if len(signaled) < MIN_SAMPLE_SIZE or len(baseline) < MIN_SAMPLE_SIZE:
                continue

            stat, p = mannwhitneyu(signaled, baseline, alternative="two-sided")
            results.append({
                "horizon_days": horizon,
                "rule": " AND ".join(keys) + "=signal (vs baseline)",
                "combo_size": len(keys),
                "n_signaled": len(signaled),
                "n_baseline": len(baseline),
                "mean_return_signaled": signaled.mean(),
                "mean_return_baseline": baseline.mean(),
                "diff": signaled.mean() - baseline.mean(),
                "p_value": p,
            })

    result_df = pd.DataFrame(results)
    if result_df.empty:
        print("補正後の有意水準判定に使える組み合わせがありませんでした"
              f"（min_support={MIN_SUPPORT}・最小サンプル数{MIN_SAMPLE_SIZE}件を満たすものなし）")
        return result_df
    result_df["p_adj_fdr"] = multipletests(result_df["p_value"], method="fdr_bh")[1]
    result_df = result_df.sort_values("p_adj_fdr")
    return result_df


if __name__ == "__main__":
    REPO_ROOT = "."
    from_date, to_date = parse_date_range("組み合わせ検定（Apriori風探索 + Mann-Whitney U + FDR補正）を単体実行する")

    price, trading_dates = load_price_series(REPO_ROOT)
    print(f"ohlcvアーカイブ収録日付: {trading_dates[0]} 〜 {trading_dates[-1]}（計{len(trading_dates)}日）")

    heur = load_heuristics(REPO_ROOT, from_date=from_date, to_date=to_date)
    heur_dates = sorted(heur.keys())
    print(f"heuristicsファイル日付: {heur_dates[0]} 〜 {heur_dates[-1]}（計{len(heur_dates)}日）")

    result_df = run_combination_test(price, trading_dates, heur)

    pd.set_option("display.width", 160)
    pd.set_option("display.max_rows", 200)
    print("\n=== 組み合わせ検定 全結果（p_adj_fdr昇順・上位20件） ===")
    print(result_df.head(20).to_string(index=False))

    if "p_adj_fdr" in result_df.columns:
        print("\n=== 補正後 有意水準5%未満の組み合わせ ===")
        sig = result_df[result_df["p_adj_fdr"] < 0.05]
        print(sig.to_string(index=False) if len(sig) else "該当なし")

    Path("analysis/output").mkdir(parents=True, exist_ok=True)
    result_df.to_csv("analysis/output/result_combinations.csv", index=False)
