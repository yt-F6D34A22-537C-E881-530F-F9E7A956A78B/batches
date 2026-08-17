"""analysis/common/volume_features.py

出来高（急増度）を、既存のTECH_*シグナルと掛け合わせて検証するための
補助特徴量を計算する。

# 何を計算するか
各銘柄・各日について、「その日の出来高が、直近N営業日（当日を含まない）の
平均出来高の何倍か」（volume_ratio）を求め、比率に応じて high / normal / low
の3区分（volume_bucket）に分類する。

# なぜ「当日を含まない」平均にするか
当日の出来高自体を基準（平均）の計算に含めてしまうと、出来高が急増した
まさにその日の比率が自己参照的に薄まってしまう（例：20日平均に当日を
含めると、急増日でも比率が本来より小さく出る）。「直近の"平常時"と比べて
今日はどうか」を測るため、当日を除いた直近N日で平均を取る。

# なぜ区分（bucket）にするか
既存の pooled/daywise 検定は「signal群 vs baseline群」の2群比較という
枠組みのため、連続値のままでは組み込みにくい。3区分にすることで、
「TECH_*シグナル AND 出来高急増（high）」のように、既存の
analyze_heuristics_signals.py の枠組み（build_long_df・classify方式）に
自然に接続できる。

しきい値（VOLUME_SURGE_HIGH_RATIO・VOLUME_SURGE_LOW_RATIO）は、いずれも
初期値（推測）。実データでの分布・検定結果を見ながら調整する想定
（analysis/common/plain_language.py 等、他モジュールの「初期値（推測値）」
という既存の方針にならう）。
"""
import pandas as pd

VOLUME_SURGE_LOOKBACK_DAYS = 20  # 「直近の平常時」とみなす日数
VOLUME_SURGE_MIN_HISTORY = 10    # 遡及可能な日数がこれ未満の場合は判定しない（銘柄の上場間もない期間等）
VOLUME_SURGE_HIGH_RATIO = 2.0    # 直近平均の2倍以上 → high（出来高急増）
VOLUME_SURGE_LOW_RATIO = 0.5     # 直近平均の0.5倍未満 → low（出来高閑散）


def compute_volume_buckets(ohlc_v: dict, lookback_days: int = VOLUME_SURGE_LOOKBACK_DAYS,
                            min_history: int = VOLUME_SURGE_MIN_HISTORY,
                            high_ratio: float = VOLUME_SURGE_HIGH_RATIO,
                            low_ratio: float = VOLUME_SURGE_LOW_RATIO) -> dict[str, dict[str, str]]:
    """{code: {date: "high"|"normal"|"low"}} を返す。

    ohlc_v: common.repo_data.load_ohlc_series_with_volume() の戻り値（{code: {date: {"v":...}}}）。

    銘柄ごとに日付昇順で出来高を並べ、pandasのrolling（当日を除くwindow）で
    直近lookback_days日の平均出来高を計算し、当日出来高との比率で分類する。
    直近の遡及可能日数がmin_history未満の日（上場間もない銘柄の初期期間等）は
    判定不能としてNone（=呼び出し側で対象外扱い）とする。
    """
    result: dict[str, dict[str, str]] = {}

    for code, daily in ohlc_v.items():
        dates = sorted(daily.keys())
        volumes = [daily[d].get("v") for d in dates]

        s = pd.Series(volumes, index=dates, dtype="float64")
        # shift(1)で当日を除いた直近lookback_days日の平均を取る
        rolling_mean = s.shift(1).rolling(window=lookback_days, min_periods=min_history).mean()

        buckets: dict[str, str] = {}
        for date, vol, avg in zip(dates, s, rolling_mean):
            if pd.isna(vol) or pd.isna(avg) or avg <= 0:
                continue  # 判定不能（min_history未達・出来高欠損等）
            ratio = vol / avg
            if ratio >= high_ratio:
                buckets[date] = "high"
            elif ratio < low_ratio:
                buckets[date] = "low"
            else:
                buckets[date] = "normal"

        if buckets:
            result[code] = buckets

    return result


def compute_volume_ratio_series(ohlc_v: dict, lookback_days: int = VOLUME_SURGE_LOOKBACK_DAYS,
                                 min_history: int = VOLUME_SURGE_MIN_HISTORY) -> dict[str, dict[str, float]]:
    """{code: {date: volume_ratio}} を返す（当日出来高 ÷ 直近lookback_days日平均出来高）。

    [2026-08追加] compute_volume_buckets() は high/normal/low の3区分に丸めるが、
    「出来高◯倍以上」という閾値を複数パターン試して境界値を探る用途には、
    丸める前の連続値の方が使い回しやすいため、区分前の比率を返す版を追加した。
    ロジック（rolling窓の取り方）はcompute_volume_buckets()と同一。
    """
    result: dict[str, dict[str, float]] = {}
    for code, daily in ohlc_v.items():
        dates = sorted(daily.keys())
        volumes = [daily[d].get("v") for d in dates]
        s = pd.Series(volumes, index=dates, dtype="float64")
        rolling_mean = s.shift(1).rolling(window=lookback_days, min_periods=min_history).mean()

        ratios: dict[str, float] = {}
        for date, vol, avg in zip(dates, s, rolling_mean):
            if pd.isna(vol) or pd.isna(avg) or avg <= 0:
                continue
            ratios[date] = vol / avg
        if ratios:
            result[code] = ratios
    return result


def compute_trading_value_series(ohlc_v: dict) -> dict[str, dict[str, float]]:
    """{code: {date: trading_value}} を返す（売買代金 = 終値 × 出来高、円）。

    [2026-08追加] 「小型株はスプレッドが広く実際には約定しにくい」といった
    流動性の考慮のため、出来高（株数）だけでなく金額ベースの売買代金でも
    足切りできるようにする。始値・高値・安値ではなく終値を使うのは、
    出来高（v）自体がその日1日分の合計値であり、日中平均的な価格の代表値として
    終値を使うのが単純で妥当なため（VWAP等の厳密な計算は行わない、簡易近似）。
    """
    result: dict[str, dict[str, float]] = {}
    for code, daily in ohlc_v.items():
        values: dict[str, float] = {}
        for date, bar in daily.items():
            c, v = bar.get("c"), bar.get("v")
            if c is None or v is None:
                continue
            values[date] = c * v
        if values:
            result[code] = values
    return result
