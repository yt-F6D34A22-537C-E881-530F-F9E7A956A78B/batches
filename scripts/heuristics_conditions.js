// ---------------------------------------------------------
// heuristics_conditions.js
// 全テクニカル条件を 1 ファイルにまとめた版（現時点）
// ---------------------------------------------------------

// =========================================================
// 共通関数
// =========================================================

// ---------------------------------------------------------
// MA 計算（共通）
// ---------------------------------------------------------
function calcMA(candles, period) {
  const dates = Object.keys(candles).sort();
  const closes = dates.map(d => candles[d].c);

  if (closes.length < period) {
    throw new Error(`Not enough candles for MA${period}`);
  }

  const slice = closes.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

// ---------------------------------------------------------
// MA 傾き（Slope）
// ---------------------------------------------------------
function isMaSlopeUp(candles, period) {
  const dates = Object.keys(candles).sort();
  if (dates.length < period + 1) {
    throw new Error(`Not enough candles for MA slope check (period=${period})`);
  }

  const todayCandles = {};
  const prevCandles = {};

  dates.forEach(d => todayCandles[d] = candles[d]);
  dates.slice(0, -1).forEach(d => prevCandles[d] = candles[d]);

  const maToday = calcMA(todayCandles, period);
  const maPrev  = calcMA(prevCandles, period);

  return maToday > maPrev;
}

function isMaSlopeDown(candles, period) {
  const dates = Object.keys(candles).sort();
  if (dates.length < period + 1) {
    throw new Error(`Not enough candles for MA slope check (period=${period})`);
  }

  const todayCandles = {};
  const prevCandles = {};

  dates.forEach(d => todayCandles[d] = candles[d]);
  dates.slice(0, -1).forEach(d => prevCandles[d] = candles[d]);

  const maToday = calcMA(todayCandles, period);
  const maPrev  = calcMA(prevCandles, period);

  return maToday < maPrev;
}

// ---------------------------------------------------------
// 足種別のラッパー関数（期間は後で調整可能）
// ---------------------------------------------------------
export function isMaSlopeUpDaily(daily) {
  return isMaSlopeUp(daily, 25);
}

export function isMaSlopeDownDaily(daily) {
  return isMaSlopeDown(daily, 25);
}

export function isMaSlopeUpWeekly(weekly) {
  return isMaSlopeUp(weekly, 13);
}

export function isMaSlopeDownWeekly(weekly) {
  return isMaSlopeDown(weekly, 13);
}

export function isMaSlopeUpMonthly(monthly) {
  return isMaSlopeUp(monthly, 12);
}

export function isMaSlopeDownMonthly(monthly) {
  return isMaSlopeDown(monthly, 12);
}

// =========================================================
// パーフェクトオーダー（PO / RPO）
// =========================================================

function getMA(candles, period) {
  return calcMA(candles, period);
}

function isPerfectOrder(candles, shortP, midP, longP) {
  const maS = getMA(candles, shortP);
  const maM = getMA(candles, midP);
  const maL = getMA(candles, longP);

  return (maS > maM) && (maM > maL);
}

function isReversePerfectOrder(candles, shortP, midP, longP) {
  const maS = getMA(candles, shortP);
  const maM = getMA(candles, midP);
  const maL = getMA(candles, longP);

  return (maS < maM) && (maM < maL);
}

export function isPerfectOrderDaily(daily) {
  return isPerfectOrder(daily, 5, 25, 75);
}

export function isReversePerfectOrderDaily(daily) {
  return isReversePerfectOrder(daily, 5, 25, 75);
}

export function isPerfectOrderWeekly(weekly) {
  return isPerfectOrder(weekly, 5, 13, 26);
}

export function isReversePerfectOrderWeekly(weekly) {
  return isReversePerfectOrder(weekly, 5, 13, 26);
}

export function isPerfectOrderMonthly(monthly) {
  return isPerfectOrder(monthly, 5, 12, 24);
}

export function isReversePerfectOrderMonthly(monthly) {
  return isReversePerfectOrder(monthly, 5, 12, 24);
}

// =========================================================
// PRE-PO / PRE-RPO（前夜）
// ※ まだ未実装（次ステップで実装）
// =========================================================
export function isPrePerfectOrder(daily) { return false; }
export function isPreReversePerfectOrder(daily) { return false; }

// =========================================================
// MA 密集
// =========================================================
export function isMaCongestionUp(daily) { return false; }
export function isMaCongestionDown(daily) { return false; }

// =========================================================
// MA 間隔
// =========================================================
export function isMaSpreadUp(daily) { return false; }
export function isMaSpreadDown(daily) { return false; }

// =========================================================
// 100日線トレンド（後で実装）
// =========================================================
export function isMa100TrendUp(daily) { return false; }
export function isMa100TrendDown(daily) { return false; }

// =========================================================
// 下半身 / 逆下半身（名称修正済み）
// =========================================================
export function isKahanshin(daily) { return false; }
export function isGyakuKahanshin(daily) { return false; }

// =========================================================
// 5日線更新
// =========================================================
export function is5MaHighUpdate(daily) { return false; }
export function is5MaLowUpdate(daily) { return false; }

// =========================================================
// 酒田五法
// =========================================================
export function isSakataTripleTop(daily) { return false; }
export function isSakataTripleBottom(daily) { return false; }
export function isSakataSankuUp(daily) { return false; }
export function isSakataSankuDown(daily) { return false; }
export function isSakataSanpeiUp(daily) { return false; }
export function isSakataSanpeiDown(daily) { return false; }
export function isSakataSanpoUp(daily) { return false; }
export function isSakataSanpoDown(daily) { return false; }

// =========================================================
// 三尊
// =========================================================
export function isHeadAndShoulders(daily) { return false; }

// =========================================================
// W底
// =========================================================
export function isDoubleBottom(daily) { return false; }

// =========================================================
// N大
// =========================================================
export function isNichiDai(daily) { return false; }
export function isGyakuNichiDai(daily) { return false; }

// =========================================================
// ものわかれ
// =========================================================
export function isMonowakareUp(daily) { return false; }
export function isMonowakareDown(daily) { return false; }

// =========================================================
// ものわかれ（赤青交差）
// =========================================================
export function isMonowakareCrossUp(daily, weekly, monthly) { return false; }
export function isMonowakareCrossDown(daily, weekly, monthly) { return false; }

// =========================================================
// 9の法則（後で実装）
// =========================================================
export function isRule9UpDaily(daily) { return false; }
export function isRule9DownDaily(daily) { return false; }
export function isRule9UpWeekly(weekly) { return false; }
export function isRule9DownWeekly(weekly) { return false; }

// =========================================================
// ボリンジャーバンド
// =========================================================
export function isBbZoneBreakDown(daily) { return false; }

// =========================================================
// サイクル
// =========================================================
export function isCycleUp(daily) { return false; }
export function isCycleDown(daily) { return false; }

// =========================================================
// 話題性
// =========================================================
export function isSentimentOverheat(daily) { return false; }

// =========================================================
// ステイ（横ばい）
// =========================================================
export function isStayBox(daily) { return false; }
