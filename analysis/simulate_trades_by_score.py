"""analysis/simulate_trades_by_score.py

app/heuristics_scoring.py・app/heuristics_scoring_rules.py が算出する
heuristicsスコア（calc_heuristics_score()）を使った売買シミュレーション
（2026-08追加）。UIのheuristicsモードのスクリーニング結果（スコア順）を
実際に売買した場合の成績を検証する。

以下のパターンを検証する：
  A. 上位N銘柄方式：日ごとにスコア上位N銘柄だけを売買対象にする
     （UIで「スコア上位◯件だけ売買する」場合に相当）
  B. スコア閾値方式：日ごとにスコアが一定以上の銘柄すべてを売買対象にする
  C. 上記A・Bに、出来高急増度・売買代金のしきい値フィルタを重ねる
  D. 上記すべてについて、下落方向スコア（down）を使った空売り版も検証する

# 既存 simulate_trades.py との役割分担
「1回のシグナルをどう売買するか」（エントリー/エグジットのタイミング・
保有期間）のグリッドサーチは simulate_trades.py の simulate_rule() を
そのまま再利用する。本ファイルが新規に担うのは「どの銘柄をシグナル対象に
するか」の選定ロジック（個別のTECH_*ルールではなく、スコアの日次
クロスセクション・ランキングやしきい値によるもの）のみ。

# app.heuristics_scoring への依存について
本スクリプトは backend の app/heuristics_scoring.py・app/heuristics_scoring_rules.py を
そのままimportして使う（スコアリングロジックを複製・二重管理してロジックが
乖離することを避けるため）。app/ は別リポジトリ（webapp-backend、公開リポジトリ）に
あるため、.github/workflows/simulate_trades.yml 側で事前にcheckoutしたパスを
sys.pathに追加している。詳細はこのファイル冒頭のimport部分を参照。

# 計算コストへの注意（2026-08、analyze_heuristics_signal_combinations.py の
# CIタイムアウトの教訓を踏まえた設計）
既存の simulate_trades.py は「特定のTECH_*が既にsignal判定になっている
(code,date)」だけを対象にするが、本ファイルは対象期間の全heuristics日 ×
全銘柄についてスコアを計算する必要があり、計算コストが大きい。そのため
しきい値の候補リスト（TOP_N_CANDIDATES等）は意図的に少数に絞ってある
（初期値・推測。実行時間を見ながら増減させること）。
"""
import sys
from pathlib import Path

import pandas as pd

_ANALYSIS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _ANALYSIS_DIR.parent
_WEBAPP_BACKEND_DIR = _REPO_ROOT / "webapp-backend"  # .github/workflows/simulate_trades.yml の checkout先と一致させること

sys.path.insert(0, str(_ANALYSIS_DIR))
sys.path.insert(0, str(_WEBAPP_BACKEND_DIR))

from common.cli import parse_date_range
from common.repo_data import load_ohlc_series, load_ohlc_series_with_volume, load_heuristics
from common.volume_features import compute_volume_ratio_series, compute_trading_value_series
from simulate_trades import simulate_rule, OUTLIER_ABS_RETURN_THRESHOLD

try:
    from app.heuristics_scoring import calc_heuristics_score
except ImportError as e:
    raise ImportError(
        f"app.heuristics_scoring のimportに失敗しました（参照先: {_WEBAPP_BACKEND_DIR}）。"
        "GitHub Actions実行時は .github/workflows/simulate_trades.yml の"
        "「Checkout webapp-backend」ステップでこのパスにcheckoutされている前提です。"
        "ローカル実行等でこのエラーが出る場合は、webapp-backendリポジトリを"
        "本リポジトリ直下の webapp-backend/ に配置してください。"
    ) from e


# ==== しきい値候補（初期値・推測。要調整） ====
TOP_N_CANDIDATES = [1, 2, 3, 5, 10]
SCORE_THRESHOLD_CANDIDATES = [5, 10, 15, 20]
# None = フィルタなし（出来高・売買代金による足切りを行わない基準ケース）
VOLUME_RATIO_THRESHOLDS = [None, 1.5, 2.0, 3.0]       # 直近20日平均出来高の何倍以上か
TRADING_VALUE_THRESHOLDS = [None, 100_000_000, 500_000_000, 1_000_000_000]  # 円（売買代金）

MIN_INSTANCES = 30  # simulate_rule() 側のMIN_SAMPLE_SIZEと揃えた足切り（計算の早期スキップ用）


def compute_daily_scores(heur: dict) -> dict[str, dict[str, dict]]:
    """{date: {code: {"up": int, "down": int}}} を返す。

    app.heuristics_scoring.calc_heuristics_score() をそのまま呼び出す
    （applied_up_rules/applied_down_rules は本スクリプトでは使わないため保持しない）。
    """
    scores: dict[str, dict[str, dict]] = {}
    for d, codes_today in heur.items():
        day_scores = {}
        for code, tech in codes_today.items():
            s = calc_heuristics_score(tech)
            day_scores[code] = {"up": s["up"], "down": s["down"]}
        scores[d] = day_scores
    return scores


def make_liquidity_filter(volume_ratio: dict, trading_value: dict,
                           min_volume_ratio: float | None, min_trading_value: float | None):
    """(code, date) が出来高比率・売買代金のしきい値を満たすかを判定する関数を返す。
    両方Noneの場合はNoneを返す（呼び出し側でフィルタなし扱いにするため）。
    """
    if min_volume_ratio is None and min_trading_value is None:
        return None

    def _filter(code: str, date: str) -> bool:
        if min_volume_ratio is not None:
            r = volume_ratio.get(code, {}).get(date)
            if r is None or r < min_volume_ratio:
                return False
        if min_trading_value is not None:
            tv = trading_value.get(code, {}).get(date)
            if tv is None or tv < min_trading_value:
                return False
        return True

    return _filter


def select_top_n_instances(daily_scores: dict, score_key: str, n: int, liquidity_filter=None) -> list[tuple[str, str]]:
    """日ごとにscore_key（"up"|"down"）の上位n銘柄を選び、(code, date)のリストを返す。
    スコアが0以下の銘柄は対象にしない（「該当ルールが1つも発火していない」銘柄を
    無理に売買対象にする意味がないため）。同点はコード文字列の昇順で安定的にタイブレークする。
    """
    instances = []
    for d, day_scores in daily_scores.items():
        candidates = [(code, s[score_key]) for code, s in day_scores.items() if s[score_key] > 0]
        if liquidity_filter is not None:
            candidates = [(code, sc) for code, sc in candidates if liquidity_filter(code, d)]
        candidates.sort(key=lambda x: (-x[1], x[0]))
        for code, _ in candidates[:n]:
            instances.append((code, d))
    return instances


def select_threshold_instances(daily_scores: dict, score_key: str, threshold: int, liquidity_filter=None) -> list[tuple[str, str]]:
    """日ごとにscore_key（"up"|"down"）がthreshold以上の銘柄すべてを選び、(code, date)のリストを返す。"""
    instances = []
    for d, day_scores in daily_scores.items():
        for code, s in day_scores.items():
            if s[score_key] < threshold:
                continue
            if liquidity_filter is not None and not liquidity_filter(code, d):
                continue
            instances.append((code, d))
    return instances


def run_all_variants(ohlc: dict, trading_dates: list, daily_scores: dict,
                      volume_ratio: dict, trading_value: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    """全パターン（上位N方式／スコア閾値方式 × 出来高・売買代金フィルタ × ロング／ショート）
    を総当たりでシミュレーションし、(集計結果, 異常値の疑いがある個別取引一覧) を返す。
    """
    all_records = []
    all_outliers = []

    liquidity_variants = [
        (vr, tv) for vr in VOLUME_RATIO_THRESHOLDS for tv in TRADING_VALUE_THRESHOLDS
    ]

    for score_key, direction in [("up", "long"), ("down", "short")]:
        # --- A. 上位N銘柄方式 ---
        for n in TOP_N_CANDIDATES:
            for vr, tv in liquidity_variants:
                filt = make_liquidity_filter(volume_ratio, trading_value, vr, tv)
                instances = select_top_n_instances(daily_scores, score_key, n, filt)
                if len(instances) < MIN_INSTANCES:
                    continue
                sim_df, outliers, _ = simulate_rule(ohlc, trading_dates, instances, direction=direction)
                if sim_df.empty:
                    continue
                sim_df.insert(0, "selection_type", "top_n")
                sim_df.insert(1, "score_key", score_key)
                sim_df.insert(2, "direction", direction)
                sim_df.insert(3, "top_n", n)
                sim_df.insert(4, "score_threshold", None)
                sim_df.insert(5, "volume_ratio_threshold", vr)
                sim_df.insert(6, "trading_value_threshold", tv)
                all_records.append(sim_df)
                all_outliers.extend(outliers)

        # --- B. スコア閾値方式 ---
        for th in SCORE_THRESHOLD_CANDIDATES:
            for vr, tv in liquidity_variants:
                filt = make_liquidity_filter(volume_ratio, trading_value, vr, tv)
                instances = select_threshold_instances(daily_scores, score_key, th, filt)
                if len(instances) < MIN_INSTANCES:
                    continue
                sim_df, outliers, _ = simulate_rule(ohlc, trading_dates, instances, direction=direction)
                if sim_df.empty:
                    continue
                sim_df.insert(0, "selection_type", "score_threshold")
                sim_df.insert(1, "score_key", score_key)
                sim_df.insert(2, "direction", direction)
                sim_df.insert(3, "top_n", None)
                sim_df.insert(4, "score_threshold", th)
                sim_df.insert(5, "volume_ratio_threshold", vr)
                sim_df.insert(6, "trading_value_threshold", tv)
                all_records.append(sim_df)
                all_outliers.extend(outliers)

    result_df = pd.concat(all_records, ignore_index=True) if all_records else pd.DataFrame()
    return result_df, all_outliers


def select_best_by_winrate(result_df: pd.DataFrame, top_n: int = 30) -> pd.DataFrame:
    """selection_type・score_key・direction・top_n・score_threshold・volume_ratio_threshold・
    trading_value_thresholdの組み合わせ（＝1つの売買パターン）ごとに、win_rateが最も高い
    エントリー/エグジットの組み合わせを1行だけ残し、win_rate降順でtop_n件を返す。
    """
    if result_df.empty:
        return result_df
    group_cols = ["selection_type", "score_key", "direction", "top_n", "score_threshold",
                  "volume_ratio_threshold", "trading_value_threshold"]
    idx = result_df.groupby(group_cols, dropna=False)["win_rate"].idxmax()
    best = result_df.loc[idx].sort_values("win_rate", ascending=False)
    return best.head(top_n)


if __name__ == "__main__":
    REPO_ROOT = str(_REPO_ROOT)
    from_date, to_date = parse_date_range("スコアベース売買シミュレーション（上位N銘柄・スコア閾値・出来高/売買代金フィルタ）を実行する")

    ohlc, trading_dates = load_ohlc_series(REPO_ROOT, from_date=from_date)
    print(f"ohlcvアーカイブ収録日付: {trading_dates[0]} 〜 {trading_dates[-1]}（計{len(trading_dates)}日）")

    ohlc_v, _ = load_ohlc_series_with_volume(REPO_ROOT, from_date=from_date)
    volume_ratio = compute_volume_ratio_series(ohlc_v)
    trading_value = compute_trading_value_series(ohlc_v)

    heur = load_heuristics(REPO_ROOT, from_date=from_date, to_date=to_date)
    heur_dates = sorted(heur.keys())
    print(f"heuristicsファイル日付: {heur_dates[0]} 〜 {heur_dates[-1]}（計{len(heur_dates)}日）")

    print("heuristicsスコアを計算中...")
    daily_scores = compute_daily_scores(heur)

    print(f"検証パターン数（概算）: top_n {len(TOP_N_CANDIDATES)}通り + "
          f"score_threshold {len(SCORE_THRESHOLD_CANDIDATES)}通り、"
          f"出来高/売買代金フィルタ {len(VOLUME_RATIO_THRESHOLDS) * len(TRADING_VALUE_THRESHOLDS)}通り、"
          f"ロング/ショート2通り")

    result_df, outliers = run_all_variants(ohlc, trading_dates, daily_scores, volume_ratio, trading_value)

    pd.set_option("display.width", 220)
    pd.set_option("display.max_rows", 200)

    if result_df.empty:
        print("シミュレーション結果がありませんでした（いずれのパターンも最小サンプル数未満）。")
    else:
        print(f"\n総パターン数: {len(result_df)}")
        best_by_winrate = select_best_by_winrate(result_df, top_n=30)
        print("\n=== 勝率が高い上位30パターン ===")
        print(best_by_winrate.to_string(index=False))

        Path("analysis/output").mkdir(parents=True, exist_ok=True)
        result_df.to_csv("analysis/output/result_trade_simulation_by_score.csv", index=False)
        best_by_winrate.to_csv("analysis/output/result_trade_simulation_by_score_best_by_winrate.csv", index=False)

        if outliers:
            pd.DataFrame(outliers).to_csv("analysis/output/result_trade_simulation_by_score_outliers.csv", index=False)
            print(f"\n異常値の疑いがある取引（|リターン|>{OUTLIER_ABS_RETURN_THRESHOLD}）: {len(outliers)}件"
                  " → result_trade_simulation_by_score_outliers.csv")
