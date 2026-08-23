"""analysis/simulate_trades_combo_volume.py

analyze_heuristics_signals_by_volume.py（既存TECH_*シグナルの出来高区分による
層別検定）で有望と見られた組み合わせ（例：TECH_HEAD_AND_SHOULDERS × 出来高急増）
について、simulate_trades.py と同水準の厳密さ（エントリー/エグジットのタイミング
グリッドサーチ・異常値除外）で実際の売買シミュレーションを行う（2026-08追加）。

# なぜ simulate_trades_by_score.py や analyze_heuristics_signals_by_volume.py と別か
- analyze_heuristics_signals_by_volume.py は統計的検定（有意かどうか）のみで、
  実際に売買した場合の勝率・プロフィットファクターまでは計算しない。
- simulate_trades_by_score.py は「スコア上位N銘柄」等、機械的な総当たりのため、
  多重比較でノイズを拾いやすい（実際、2026-08の検証で明確な効果は確認できなかった）。
本ファイルは、上記2つの検証を踏まえて「根拠のある特定の組み合わせ」だけを
対象にする、より的を絞った検証として追加した。

# 評価方法について
win_rate（勝率）だけでなく、profit_factor（プロフィットファクター＝総利益÷総損失の
絶対値）・avg_win/avg_loss（勝ち負けそれぞれの平均リターン）も一緒に見る。
勝率が50%台でも、勝ったときのリターンが負けたときより十分大きければ
（profit_factor > 1）、トータルではプラスの期待値になり得るため
（詳細は simulate_trades.py の simulate_rule() 内のコメントを参照）。

# 対象の組み合わせを追加・変更する場合
TARGET_COMBOS を編集する。(TECH_*キー, volume_bucket, direction) のタプルで指定する。
directionは analyze_heuristics_signals_by_volume.py の結果（result_by_volume_summary.csv
の該当行のdiffの符号）を見て、diffが正なら"long"、負なら"short"を指定すること
（simulate_trades.load_promising_rules() が診断する方法と同じ考え方）。
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import ttest_1samp

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common.cli import parse_date_range
from common.repo_data import load_ohlc_series, load_ohlc_series_with_volume, load_heuristics
from common.tech_rules import classify
from common.volume_features import compute_volume_buckets
from simulate_trades import simulate_rule, OUTLIER_ABS_RETURN_THRESHOLD

# ==== 検定・ブートストラップの設定（2026-08追加） ====
BOOTSTRAP_ITERATIONS = 2000  # リサンプリング回数（初期値・推測。増やすほど安定するが実行時間が伸びる）
BOOTSTRAP_CI = 0.95          # 信頼区間の水準
BOOTSTRAP_SEED = 42          # 再現性のため固定（実行のたびに結果が微妙に変わるのを避ける）


def _bootstrap_ci(returns: list[float], statistic_fn, n_boot: int = BOOTSTRAP_ITERATIONS,
                   ci: float = BOOTSTRAP_CI, rng: np.random.Generator | None = None) -> tuple[float, float]:
    """returnsを復元抽出でn_boot回リサンプリングし、statistic_fn（例：np.mean）を
    毎回計算した分布から、ci（例：0.95）水準の信頼区間（下限, 上限）を返す。

    正規分布を仮定するt検定とは異なり、分布の形（右に歪んだ分布等）を仮定しない
    ノンパラメトリックな方法。プロフィットファクターのような比率統計量は
    t検定の枠組みに乗らないため、ブートストラップで信頼区間を出す。

    statistic_fnが計算不能（例：リサンプリング後に負けトレードが1件もなく
    プロフィットファクターが定義できない）な場合はNaNを返す前提とし、
    NaNを除いたパーセンタイルを計算する（全てNaNの場合は(NaN, NaN)を返す）。
    """
    if rng is None:
        rng = np.random.default_rng(BOOTSTRAP_SEED)
    arr = np.asarray(returns)
    n = len(arr)
    stats = np.empty(n_boot)
    for i in range(n_boot):
        sample = rng.choice(arr, size=n, replace=True)
        stats[i] = statistic_fn(sample)
    stats = stats[~np.isnan(stats)]
    if len(stats) == 0:
        return float("nan"), float("nan")
    alpha = (1 - ci) / 2
    lo, hi = np.percentile(stats, [alpha * 100, (1 - alpha) * 100])
    return float(lo), float(hi)


def _profit_factor_stat(sample: np.ndarray) -> float:
    gains = sample[sample > 0].sum()
    losses = abs(sample[sample < 0].sum())
    return gains / losses if losses > 0 else float("nan")


def _win_rate_stat(sample: np.ndarray) -> float:
    return float((sample > 0).mean())


def compute_significance_stats(returns: list[float]) -> dict:
    """1つの売買パターン（entry_type/exit_type/days_after_signal固定）について、
    平均リターンが0と有意に異なるかのt検定と、mean_return・win_rate・profit_factorの
    ブートストラップ95%信頼区間を計算する。

    t検定について: 個々の取引を独立な観測として扱っているが、同じ銘柄・近い時期の
    取引は本来相関を持ち得る（analyze_heuristics_signals_daywise.py が pooled検定
    に対して daywise検定を用意しているのと同じ理由）。そのため、ここでのp値は
    やや楽観的（本来より小さく＝有意に出やすく）なっている可能性がある点に留意すること
    （厳密な補正は将来の拡張候補とし、今回はt検定＋ブートストラップという2つの
    視点を示すことで、単一の指標に頼りすぎないようにする）。
    """
    arr = np.asarray(returns)
    t_stat, p_value = ttest_1samp(arr, popmean=0.0)

    mean_lo, mean_hi = _bootstrap_ci(returns, np.mean)
    win_rate_lo, win_rate_hi = _bootstrap_ci(returns, _win_rate_stat)
    pf_lo, pf_hi = _bootstrap_ci(returns, _profit_factor_stat)

    return {
        "mean_return_p_value": p_value,
        "mean_return_ci_low": mean_lo,
        "mean_return_ci_high": mean_hi,
        "win_rate_ci_low": win_rate_lo,
        "win_rate_ci_high": win_rate_hi,
        "profit_factor_ci_low": pf_lo,
        "profit_factor_ci_high": pf_hi,
    }

# ==== 検証対象の組み合わせ ====
# result_by_volume_summary.csv で、出来高急増(high)時に一貫してプラス方向の
# 効果が見られた組み合わせ（2026-08時点）。
TARGET_COMBOS = [
    ("TECH_HEAD_AND_SHOULDERS", "high", "long"),
    ("TECH_MOMIAI", "high", "long"),
]


def find_combo_instances(heur: dict, volume_buckets: dict, tech_key: str, bucket: str) -> list[tuple[str, str]]:
    """指定したTECH_*キーがsignal判定 かつ 指定した出来高区分に該当する
    (code, date) のリストを返す。"""
    instances = []
    for d, codes_today in heur.items():
        for code, techs in codes_today.items():
            if classify(techs.get(tech_key)) != "signal":
                continue
            if volume_buckets.get(code, {}).get(d) != bucket:
                continue
            instances.append((code, d))
    return instances


if __name__ == "__main__":
    REPO_ROOT = "."
    from_date, to_date = parse_date_range("特定ルール×出来高区分の組み合わせシミュレーションを実行する")

    ohlc, trading_dates = load_ohlc_series(REPO_ROOT, from_date=from_date)
    print(f"ohlcvアーカイブ収録日付: {trading_dates[0]} 〜 {trading_dates[-1]}（計{len(trading_dates)}日）")

    ohlc_v, _ = load_ohlc_series_with_volume(REPO_ROOT, from_date=from_date)
    volume_buckets = compute_volume_buckets(ohlc_v)

    heur = load_heuristics(REPO_ROOT, from_date=from_date, to_date=to_date)
    heur_dates = sorted(heur.keys())
    print(f"heuristicsファイル日付: {heur_dates[0]} 〜 {heur_dates[-1]}（計{len(heur_dates)}日）")

    pd.set_option("display.width", 220)
    pd.set_option("display.max_rows", 200)

    all_records = []
    all_outliers = []

    for tech_key, bucket, direction in TARGET_COMBOS:
        instances = find_combo_instances(heur, volume_buckets, tech_key, bucket)
        print(f"\n=== {tech_key} × 出来高({bucket}) [{direction}] ===")
        print(f"該当インスタンス数: {len(instances)}")
        if len(instances) < 30:
            print("サンプル数が少なすぎるためスキップします（最小30件）")
            continue

        sim_df, outliers, raw_returns_by_pattern = simulate_rule(ohlc, trading_dates, instances, direction=direction)
        if sim_df.empty:
            print("有効なパターンがありませんでした（各グリッドで最小サンプル数未満）")
            continue

        # [2026-08追加] パターンごとにt検定・ブートストラップ信頼区間を計算し、sim_dfへ結合する
        stats_rows = []
        for _, row in sim_df.iterrows():
            key = (row["entry_type"], row["exit_type"], row["days_after_signal"])
            returns = raw_returns_by_pattern[key]
            stats_rows.append(compute_significance_stats(returns))
        stats_df = pd.DataFrame(stats_rows)
        sim_df = pd.concat([sim_df.reset_index(drop=True), stats_df], axis=1)

        sim_df.insert(0, "tech_key", tech_key)
        sim_df.insert(1, "volume_bucket", bucket)
        sim_df.insert(2, "direction", direction)
        print(sim_df.sort_values("win_rate", ascending=False).to_string(index=False))

        all_records.append(sim_df)
        all_outliers.extend(outliers)

    if all_records:
        result_df = pd.concat(all_records, ignore_index=True)
        Path("analysis/output").mkdir(parents=True, exist_ok=True)
        result_df.to_csv("analysis/output/result_trade_simulation_combo_volume.csv", index=False)

        print("\n=== 全パターン中、勝率が高い順（上位10件） ===")
        print(result_df.sort_values("win_rate", ascending=False).head(10).to_string(index=False))
        print("\n=== 全パターン中、プロフィットファクターが高い順（上位10件） ===")
        print(result_df.sort_values("profit_factor", ascending=False).head(10).to_string(index=False))

        # [2026-08追加] 「平均リターンのp値が0.05未満」かつ「プロフィットファクターの
        # ブートストラップ信頼区間の下限が1を超える（＝リサンプリングでもほぼ確実に
        # 利益超過側になる）」の両方を満たすパターンだけを抽出する。この両条件を
        # 満たすものは、勝率・プロフィットファクター単体で見るより頑健な根拠と言える。
        robust = result_df[
            (result_df["mean_return_p_value"] < 0.05) & (result_df["profit_factor_ci_low"] > 1.0)
        ]
        print("\n=== 統計的に頑健と言えるパターン（p<0.05 かつ profit_factorの信頼区間下限>1） ===")
        if robust.empty:
            print("該当するパターンはありませんでした（現時点のサンプル数ではまだ判断できない可能性があります）")
        else:
            print(robust.sort_values("mean_return_p_value").to_string(index=False))

        if all_outliers:
            pd.DataFrame(all_outliers).to_csv("analysis/output/result_trade_simulation_combo_volume_outliers.csv", index=False)
            print(f"\n異常値の疑いがある取引（|リターン|>{OUTLIER_ABS_RETURN_THRESHOLD}）: {len(all_outliers)}件"
                  " → result_trade_simulation_combo_volume_outliers.csv")
    else:
        print("\n検証対象の組み合わせすべてでサンプル数が不足していました。")
