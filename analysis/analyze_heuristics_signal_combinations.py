"""analysis/analyze_heuristics_signal_combinations.py

TECH_*シグナルを複数（3個以上も含む）組み合わせたAND条件について、
Apriori風のレベルワイズ探索でルールマイニングを行い、
単独指標と同じ考え方（pooled Mann-Whitney U検定 + FDR補正）で
統計的優位性を検証する。

# 2026-07 修正：初版でのCIタイムアウトについて
初版は全TECH_*（54種類、実データ）をそのままApriori探索の対象にしていたが、
本番データでは以下2点により組み合わせ数が爆発し、CIジョブがタイムアウト
（ログ上は "Error: The operation was canceled." で終了）した。
  1. MIN_SUPPORT=0.02（2%）が実データのTECH_*出現率（多くが数十%）に対して
     低すぎ、Apriori本来の枝刈りがほとんど効かなかった
  2. 54列のままだと size2〜4だけで最大342,486通りの組み合わせが候補になり得た
     （15列に絞れば1,925通り、20列でも6,175通りに収まる）
このため、探索対象を「pooled検定で統計的に有意 かつ 効果量が一定以上のTECH_*」
上位N件に事前フィルタする select_candidate_keys() を追加した。
なお、サンプル数が数十万〜100万件規模の場合、統計的有意性（p値）だけでは
ほぼ全てのルールが有意になってしまう（大標本下でのp値の一般的な性質）ため、
p値だけでなく効果量（フォワードリターン差の絶対値）による足切りを併用している。

# なぜ「Apriori風」の探索が必要か
候補を絞り込んだ後でも、素朴に全組み合わせを列挙するより、Apriori
（頻出パターンマイニングの古典的アルゴリズム）の「アンチモノトーン性
（ある組み合わせがmin_support未満なら、それを含むより大きな組み合わせも
必ずmin_support未満になる）」を利用したレベルワイズ探索の方が、
低頻度で意味のない組み合わせを早期に切り捨てられ効率的なため、引き続き採用する。

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
from analyze_heuristics_signals import build_long_df, run_pooled_test, HORIZONS

# 以下の定数はいずれも初期値（推測値）。実データでの試行結果（候補件数・CI実行時間・
# 検出された有意な組み合わせの数）を見ながら調整する想定。
MIN_SUPPORT = 0.02        # 全観測のうちその組み合わせがsignalになる割合の下限（探索対象の足切り）
MAX_ITEMSET_SIZE = 4      # 組み合わせの最大個数
MIN_SAMPLE_SIZE = 30      # 単独検定（analyze_heuristics_signals.py）の最小サンプル数30件と揃えている

# 候補となるTECH_*キーを事前に絞り込むための閾値（2026-07追加、CIタイムアウト対処）
CANDIDATE_ALPHA = 0.05          # pooled検定のFDR補正後p値の上限
CANDIDATE_MIN_ABS_DIFF = 0.003  # フォワードリターン差（絶対値）の下限。0.3%未満の効果量は除外
CANDIDATE_TOP_N = 15            # 上記条件を満たすものの中から、効果量が大きい順に採用する上限件数
CANDIDATE_HARD_CAP = 20         # 万一 CANDIDATE_TOP_N の設定ミス等で想定より多く残った場合の安全弁


def select_candidate_keys(pooled_df: pd.DataFrame, alpha: float = CANDIDATE_ALPHA,
                           min_abs_diff: float = CANDIDATE_MIN_ABS_DIFF,
                           top_n: int = CANDIDATE_TOP_N) -> list[str]:
    """pooled検定結果（analyze_heuristics_signals.run_pooled_test()の戻り値）から、
    組み合わせ検定の対象とするTECH_*キーを絞り込む。

    サンプル数が数十万〜100万件規模だと、p値だけではほぼ全てのルールが
    統計的に有意になってしまい候補を絞り込めない（大標本下でのp値の性質上の限界）。
    そのため、統計的有意性（FDR補正後p値）に加えて実務的な効果量
    （フォワードリターン差の絶対値）にも下限を設け、かつ効果量が大きい順に
    top_n件へ絞ることで、組み合わせ探索の対象を現実的な件数に抑える
    （n列ならApriori探索対象はsize2〜4で最大 nC2+nC3+nC4 通り。
    n=15なら1,925通り、n=54なら342,486通りと差が大きい）。

    pooled_dfの "rule" 列は "TECH_XXX=signal (vs baseline)" 形式のため、
    "=" の前半部分をTECH_*キーとして抽出する。
    """
    if pooled_df.empty or "p_adj_fdr" not in pooled_df.columns:
        return []

    candidates = pooled_df[
        (pooled_df["p_adj_fdr"] < alpha) & (pooled_df["diff"].abs() >= min_abs_diff)
    ].copy()
    if candidates.empty:
        return []

    candidates["abs_diff"] = candidates["diff"].abs()
    candidates = candidates.sort_values("abs_diff", ascending=False).head(top_n)

    keys = sorted({rule.split("=", 1)[0] for rule in candidates["rule"]})

    if len(keys) > CANDIDATE_HARD_CAP:
        # top_n の指定を誤って大きくした場合等の保険。組み合わせ数の爆発を防ぐため
        # 強制的に上限件数までに切り詰める（キー名のソート順で先頭からではなく、
        # 呼び出し側の意図を尊重し、ここに来ること自体を異常系として警告する）。
        print(f"警告: 候補キー数が上限（{CANDIDATE_HARD_CAP}件）を超過したため、"
              f"先頭{CANDIDATE_HARD_CAP}件に切り詰めます（{len(keys)}件 → {CANDIDATE_HARD_CAP}件）")
        keys = keys[:CANDIDATE_HARD_CAP]

    return keys


def _classify_matrix(sub: pd.DataFrame, tech_cols: list[str]) -> pd.DataFrame:
    """各TECH_*列を signal/baseline/skip に分類した文字列DataFrameを作る（1回だけ計算し使い回す）。"""
    return pd.DataFrame({col: sub[col].apply(classify) for col in tech_cols})


def _frequent_itemsets(signal_matrix: pd.DataFrame) -> pd.DataFrame:
    """mlxtend.apriori で min_support 以上の頻出組み合わせ（サイズ2〜MAX_ITEMSET_SIZE）を抽出する。"""
    itemsets = apriori(signal_matrix, min_support=MIN_SUPPORT, max_len=MAX_ITEMSET_SIZE, use_colnames=True)
    itemsets["size"] = itemsets["itemsets"].apply(len)
    return itemsets[itemsets["size"] >= 2].sort_values("size")


def run_combination_test(price: dict, trading_dates: list, heur: dict,
                          candidate_keys: list[str] | None = None,
                          precomputed_df: pd.DataFrame | None = None) -> pd.DataFrame:
    """複数TECH_*の組み合わせ（AND条件）について、Apriori風探索とpooled検定を組み合わせて実行する。

    単独検定（analyze_heuristics_signals.run_pooled_test）と同じ long形式データを再利用し、
    horizon（1・3・5営業日）ごとに集計する。
    「シグナルあり」＝組み合わせ内の全キーがsignal判定、
    「ベースライン」＝組み合わせ内の全キーがbaseline判定の行とし、
    signal/baseline/skipが混在する行は単独検定同様に対象外とする
    （common.tech_rules.classify() の「分類不能な値は誤ったシグナル混入を避けるため
    明示的に対象外とする」方針をそのまま踏襲）。

    candidate_keys（2026-07追加）: 探索対象とするTECH_*キーをあらかじめ絞り込みたい場合に指定する。
    Noneの場合は全TECH_*列が対象になるが、実データ規模（数十万〜100万行×54列）では
    組み合わせ数が爆発しCIタイムアウトを招くため、run_all.py・本ファイル単体実行の
    いずれも select_candidate_keys() で事前に絞り込んだ上で渡す運用を前提とする。

    precomputed_df（2026-07追加）: build_long_df() の結果を呼び出し側が既に持っている場合に
    渡すと再構築を省略できる（pooled検定と組み合わせ検定でのbuild_long_df()二重実行を防ぐ）。
    """
    df = precomputed_df if precomputed_df is not None else build_long_df(price, trading_dates, heur)
    all_tech_cols = [c for c in df.columns if c.startswith("TECH_")]
    tech_cols = [c for c in all_tech_cols if c in candidate_keys] if candidate_keys is not None else all_tech_cols
    print(f"組み合わせ検定の対象TECH_*列数: {len(tech_cols)}（全{len(all_tech_cols)}列中）")

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

    # 組み合わせ探索の対象を事前に絞り込むため、単体実行時もまずpooled検定を走らせる
    # （run_all.py 経由の実行と同じ流れにすることで、単体実行時のみ想定外に
    # 全TECH_*が対象になりCIタイムアウトを再発する事態を避ける）。
    long_df = build_long_df(price, trading_dates, heur)
    pooled_df = run_pooled_test(price, trading_dates, heur, precomputed_df=long_df)
    candidate_keys = select_candidate_keys(pooled_df)
    print(f"組み合わせ検定の候補キー（{len(candidate_keys)}件）: {candidate_keys}")

    result_df = run_combination_test(price, trading_dates, heur,
                                      candidate_keys=candidate_keys, precomputed_df=long_df)

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
