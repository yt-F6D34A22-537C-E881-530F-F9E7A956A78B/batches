import sys
from pathlib import Path

import pandas as pd
import numpy as np
from scipy.stats import mannwhitneyu
from statsmodels.stats.multitest import multipletests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common.repo_data import load_price_series, load_heuristics
from common.tech_rules import classify, discover_tech_columns
from common.cli import parse_date_range

HORIZONS = [1, 3, 5]  # 翌営業日・3営業日後・5営業日後


def forward_dates(trading_dates, signal_date, n):
    if signal_date not in trading_dates:
        return None
    idx = trading_dates.index(signal_date)
    if idx + n >= len(trading_dates):
        return None
    return trading_dates[idx + n]


def build_long_df(price: dict, trading_dates: list, heur: dict) -> pd.DataFrame:
    """heuristicsシグナルと、HORIZONS営業日後までのフォワードリターンを結合した
    long形式（1行 = 1銘柄 × 1シグナル日 × 1horizon）のDataFrameを構築する。

    2026-07、analyze_heuristics_signal_combinations.run_combination_test() でも
    同一のデータ構築ロジックが必要になったため、run_pooled_test() 本体から切り出した
    （単独指標検定・組み合わせ検定のいずれも、起点となる観測データの構築ロジックは
    完全に同一であるため。切り出しに伴うrun_pooled_test()の出力・stdout内容の変更はない）。
    """
    heur_dates = sorted(heur.keys())

    # シグナル日として使えるのは、その日の終値が ohlcv アーカイブに存在する日のみ
    # （終値が取れない日は「エントリー価格」を計算できないため、リターン検証から除外する）
    usable_signal_dates = [d for d in heur_dates if d in trading_dates]
    excluded_dates = [d for d in heur_dates if d not in trading_dates]
    print("リターン検証に使える signal 日付数:", len(usable_signal_dates))
    print("ohlcvアーカイブの範囲外のためリターン検証から除外する日付:", excluded_dates)

    # ロング形式データフレームを構築： date × code × TECH_key × value × fwd_return_Nd
    records = []
    for d in usable_signal_dates:
        codes_today = heur[d]
        for n in HORIZONS:
            fd = forward_dates(trading_dates, d, n)
            if fd is None:
                continue
            for code, techs in codes_today.items():
                entry = price.get(code, {}).get(d)
                exitp = price.get(code, {}).get(fd)
                if entry is None or exitp is None or entry == 0:
                    continue
                fwd_ret = (exitp / entry) - 1.0
                row = {"date": d, "code": code, "horizon": n, "fwd_return": fwd_ret}
                row.update(techs)
                records.append(row)

    df = pd.DataFrame(records)
    print("観測レコード数:", len(df))
    print(df[["date", "horizon"]].value_counts().sort_index())
    return df


def run_pooled_test(price: dict, trading_dates: list, heur: dict) -> pd.DataFrame:
    """日付をまたいだ全観測をプールしたMann-Whitney U検定（FDR補正込み）。

    run_all.py から呼ぶ場合も、本ファイル単体で実行する場合も、
    データの読み込みは1回で済むようこの関数にロジックを切り出している。
    """
    df = build_long_df(price, trading_dates, heur)

    tech_cols = [c for c in df.columns if c.startswith("TECH_")]
    print("TECH_*列数:", len(tech_cols))

    # 2026-07、5種類の代表ルールに限定していた判定を、全TECH_*（bool / 1・null / up・down・flat / dict）
    # に一般化。型ごとの分類ロジックは common.tech_rules.classify() に集約（両分析スクリプトで共用）。
    results = []
    for horizon in HORIZONS:
        sub = df[df["horizon"] == horizon]
        for col in tech_cols:
            cls = sub[col].apply(classify)
            signaled = sub.loc[cls == "signal", "fwd_return"].dropna()
            baseline = sub.loc[cls == "baseline", "fwd_return"].dropna()
            signal_desc = f"{col}=signal (vs baseline)"

            if len(signaled) < 30 or len(baseline) < 30:
                continue

            stat, p = mannwhitneyu(signaled, baseline, alternative="two-sided")
            results.append({
                "horizon_days": horizon,
                "rule": signal_desc,
                "n_signaled": len(signaled),
                "n_baseline": len(baseline),
                "mean_return_signaled": signaled.mean(),
                "mean_return_baseline": baseline.mean(),
                "diff": signaled.mean() - baseline.mean(),
                "p_value": p,
            })

    result_df = pd.DataFrame(results)
    if result_df.empty:
        print("補正後の有意水準判定に使えるルールがありませんでした（最小サンプル数30件未満）")
        return result_df
    result_df["p_adj_fdr"] = multipletests(result_df["p_value"], method="fdr_bh")[1]
    result_df = result_df.sort_values("p_adj_fdr")
    return result_df


if __name__ == "__main__":
    REPO_ROOT = "."  # リポジトリルートから実行する前提
    from_date, to_date = parse_date_range("pooled検定（Mann-Whitney U + FDR補正）を単体実行する")

    price, trading_dates = load_price_series(REPO_ROOT)
    print(f"ohlcvアーカイブ収録日付: {trading_dates[0]} 〜 {trading_dates[-1]}（計{len(trading_dates)}日）")

    heur = load_heuristics(REPO_ROOT, from_date=from_date, to_date=to_date)
    heur_dates = sorted(heur.keys())
    print(f"heuristicsファイル日付: {heur_dates[0]} 〜 {heur_dates[-1]}（計{len(heur_dates)}日）")

    result_df = run_pooled_test(price, trading_dates, heur)

    pd.set_option("display.width", 160)
    pd.set_option("display.max_rows", 200)
    print("\n=== 全結果（p_adj_fdr昇順・上位20件） ===")
    print(result_df.head(20).to_string(index=False))

    if "p_adj_fdr" in result_df.columns:
        print("\n=== 補正後 有意水準5%未満のルール ===")
        sig = result_df[result_df["p_adj_fdr"] < 0.05]
        print(sig.to_string(index=False) if len(sig) else "該当なし")

    Path("analysis/output").mkdir(parents=True, exist_ok=True)
    result_df.to_csv("analysis/output/result_all.csv", index=False)
