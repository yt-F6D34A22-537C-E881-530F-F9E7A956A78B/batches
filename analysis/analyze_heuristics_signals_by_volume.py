"""analysis/analyze_heuristics_signals_by_volume.py

既存のTECH_*シグナルを、出来高急増度（volume_bucket: high/normal/low）で
層別し、「出来高が急増している状態でのシグナルは、そうでない状態と比べて
優位性が高まるか」を検証する（2026-08追加）。

# なぜ analyze_heuristics_signals.py の build_long_df() を直接拡張しないか
build_long_df() は analyze_heuristics_signal_combinations.py・run_all.py が
既に依存している共有ロジックであり、迂闊に変更すると既存の検定結果・CI挙動に
影響するリスクがある。common/repo_data.py で _build_price() に対して
_build_ohlc() を独立追加したのと同じ方針で、本ファイルは独自のlong形式
データ構築（build_long_df_with_volume()）を持つ、独立したスクリプトとして追加した。

# 検定の考え方
各TECH_*キー・各horizonについて、volume_bucket（high/normal/low）ごとに
「シグナルあり群 vs ベースライン群」のMann-Whitney U検定を行う
（analyze_heuristics_signals.run_pooled_test() と同じ検定手法・同じ
最小サンプル数30件の足切りを踏襲）。

「出来高との掛け合わせで優位性が変わるか」を見るための主眼は、同じ
TECH_*・同じhorizonで high row と normal/low row の diff（効果量）を
見比べることであり、本ファイルはbucketごとの生の検定結果を出力するに
留める（bucket間の差の有意性を別途検定する追加の統計的手続きは、
現状の検定回数・多重比較の複雑さを踏まえ、今回は行わない。将来的な拡張候補）。
"""
import sys
from pathlib import Path

import pandas as pd
from scipy.stats import mannwhitneyu
from statsmodels.stats.multitest import multipletests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common.repo_data import load_ohlc_series_with_volume, load_heuristics
from common.tech_rules import classify
from common.cli import parse_date_range
from common.volume_features import compute_volume_buckets
from analyze_heuristics_signals import forward_dates, HORIZONS

VOLUME_BUCKETS = ["high", "normal", "low"]


def build_long_df_with_volume(ohlc_v: dict, trading_dates: list, heur: dict,
                               volume_buckets: dict) -> pd.DataFrame:
    """heuristicsシグナル・フォワードリターン・出来高区分（volume_bucket）を
    結合したlong形式のDataFrameを構築する（analyze_heuristics_signals.build_long_df()
    の出来高付き版。ロジックはほぼ同一だが、価格の参照元がclose辞書ではなく
    {"o","h","l","c","v"}のdictである点、volume_bucket列を追加する点が異なる）。
    """
    heur_dates = sorted(heur.keys())
    usable_signal_dates = [d for d in heur_dates if d in trading_dates]
    excluded_dates = [d for d in heur_dates if d not in trading_dates]
    print("リターン検証に使える signal 日付数:", len(usable_signal_dates))
    print("ohlcvアーカイブの範囲外のためリターン検証から除外する日付:", excluded_dates)

    records = []
    for d in usable_signal_dates:
        codes_today = heur[d]
        for n in HORIZONS:
            fd = forward_dates(trading_dates, d, n)
            if fd is None:
                continue
            for code, techs in codes_today.items():
                bucket = volume_buckets.get(code, {}).get(d)
                if bucket is None:
                    continue  # 出来高急増度が判定不能（銘柄の上場間もない期間等）はスキップ

                entry = ohlc_v.get(code, {}).get(d, {}).get("c")
                exitp = ohlc_v.get(code, {}).get(fd, {}).get("c")
                if entry is None or exitp is None or entry == 0:
                    continue
                fwd_ret = (exitp / entry) - 1.0
                row = {"date": d, "code": code, "horizon": n, "fwd_return": fwd_ret, "volume_bucket": bucket}
                row.update(techs)
                records.append(row)

    df = pd.DataFrame(records)
    print("観測レコード数（出来高判定可能な分のみ）:", len(df))
    if not df.empty:
        print(df[["volume_bucket", "horizon"]].value_counts().sort_index())
    return df


def run_stratified_test(long_df: pd.DataFrame) -> pd.DataFrame:
    """TECH_*キー × horizon × volume_bucket ごとにMann-Whitney U検定を行う。"""
    if long_df.empty:
        return pd.DataFrame()

    tech_cols = [c for c in long_df.columns if c.startswith("TECH_")]
    print("TECH_*列数:", len(tech_cols))

    results = []
    for horizon in HORIZONS:
        sub_h = long_df[long_df["horizon"] == horizon]
        for bucket in VOLUME_BUCKETS:
            sub = sub_h[sub_h["volume_bucket"] == bucket]
            for col in tech_cols:
                cls = sub[col].apply(classify)
                signaled = sub.loc[cls == "signal", "fwd_return"].dropna()
                baseline = sub.loc[cls == "baseline", "fwd_return"].dropna()

                if len(signaled) < 30 or len(baseline) < 30:
                    continue

                stat, p = mannwhitneyu(signaled, baseline, alternative="two-sided")
                results.append({
                    "horizon_days": horizon,
                    "volume_bucket": bucket,
                    "rule": f"{col}=signal (vs baseline)",
                    "n_signaled": len(signaled),
                    "n_baseline": len(baseline),
                    "mean_return_signaled": signaled.mean(),
                    "mean_return_baseline": baseline.mean(),
                    "diff": signaled.mean() - baseline.mean(),
                    "p_value": p,
                })

    result_df = pd.DataFrame(results)
    if result_df.empty:
        print("補正後の有意水準判定に使える組み合わせがありませんでした（最小サンプル数30件未満）")
        return result_df
    result_df["p_adj_fdr"] = multipletests(result_df["p_value"], method="fdr_bh")[1]
    result_df = result_df.sort_values(["rule", "horizon_days", "volume_bucket"])
    return result_df


def summarize_volume_interaction(result_df: pd.DataFrame) -> pd.DataFrame:
    """同じTECH_*・同じhorizonで、high bucketとnormal/low bucketの効果量（diff）を
    横並びにした比較用の要約表を作る（「出来高急増で優位性が変わるか」を一目で見るため）。
    """
    if result_df.empty:
        return pd.DataFrame()

    pivot = result_df.pivot_table(index=["rule", "horizon_days"], columns="volume_bucket",
                                   values="diff", aggfunc="first").reset_index()
    for b in VOLUME_BUCKETS:
        if b not in pivot.columns:
            pivot[b] = None
    if "high" in pivot.columns and "normal" in pivot.columns:
        pivot["high_minus_normal"] = pivot["high"] - pivot["normal"]
    return pivot.sort_values("high_minus_normal", key=lambda s: s.abs(), ascending=False, na_position="last")


if __name__ == "__main__":
    REPO_ROOT = "."
    from_date, to_date = parse_date_range("出来高急増度によるTECH_*層別検定を単体実行する")

    ohlc_v, trading_dates = load_ohlc_series_with_volume(REPO_ROOT, from_date=from_date)
    print(f"ohlcvアーカイブ収録日付: {trading_dates[0]} 〜 {trading_dates[-1]}（計{len(trading_dates)}日）")

    heur = load_heuristics(REPO_ROOT, from_date=from_date, to_date=to_date)
    heur_dates = sorted(heur.keys())
    print(f"heuristicsファイル日付: {heur_dates[0]} 〜 {heur_dates[-1]}（計{len(heur_dates)}日）")

    print("出来高急増度（volume_bucket）を計算中...")
    volume_buckets = compute_volume_buckets(ohlc_v)

    long_df = build_long_df_with_volume(ohlc_v, trading_dates, heur, volume_buckets)
    result_df = run_stratified_test(long_df)

    pd.set_option("display.width", 200)
    pd.set_option("display.max_rows", 300)

    if result_df.empty:
        print("検定結果がありませんでした。")
    else:
        print("\n=== 出来高区分ごとの検定結果（全件） ===")
        print(result_df.to_string(index=False))

        summary = summarize_volume_interaction(result_df)
        print("\n=== 出来高急増(high)による効果量の変化（|high - normal|が大きい順、上位20件） ===")
        print(summary.head(20).to_string(index=False))

        Path("analysis/output").mkdir(parents=True, exist_ok=True)
        result_df.to_csv("analysis/output/result_by_volume.csv", index=False)
        summary.to_csv("analysis/output/result_by_volume_summary.csv", index=False)
