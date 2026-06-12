◆省略無し版
// ---------------------------------------------------------
// heuristics_conditions.js — SAFE 完全統合版
// ---------------------------------------------------------

// =========================================================
// 共通関数（元の関数 ＋ SAFE ラッパ）
// =========================================================

function calcMA(candles, period) {
  const dates = Object.keys(candles).sort();
  const closes = dates.map(d => candles[d].c);
  if (closes.length < period) throw new Error(`Not enough candles for MA${period}`);
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function last(candles, n) {
  const dates = Object.keys(candles).sort();
  return dates.slice(-n).map(d => candles[d]);
}

function getPrevCandles(candles, n) {
  const dates = Object.keys(candles).sort();
  if (dates.length < n) throw new Error(`Not enough candles for getPrevCandles(${n})`);
  const sliced = dates.slice(0, -n);
  const obj = {};
  sliced.forEach(d => obj[d] = candles[d]);
  return obj;
}

// ---- SAFE 版共通ヘルパ ----

function safeCalcMA(candles, period) {
  const dates = Object.keys(candles).sort();
  const closes = dates.map(d => candles[d].c);
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function safeLast(candles, n) {
  const dates = Object.keys(candles).sort();
  if (dates.length < n) return null;
  return dates.slice(-n).map(d => candles[d]);
}

function safeGetPrevCandles(candles, n, minLen) {
  const dates = Object.keys(candles).sort();
  if (dates.length < minLen) return null;
  const sliced = dates.slice(0, -n);
  const obj = {};
  sliced.forEach(d => obj[d] = candles[d]);
  return obj;
}

// =========================================================
// MA 傾き（SAFE）
// =========================================================

function isMaSlopeUp(candles, period) {
  const dates = Object.keys(candles).sort();
  if (dates.length < period + 1) return false;

  const today = {}, prev = {};
  dates.forEach(d => today[d] = candles[d]);
  dates.slice(0, -1).forEach(d => prev[d] = candles[d]);

  const maToday = safeCalcMA(today, period);
  const maPrev  = safeCalcMA(prev, period);
  if (maToday === null || maPrev === null) return false;

  return maToday > maPrev;
}

function isMaSlopeDown(candles, period) {
  const dates = Object.keys(candles).sort();
  if (dates.length < period + 1) return false;

  const today = {}, prev = {};
  dates.forEach(d => today[d] = candles[d]);
  dates.slice(0, -1).forEach(d => prev[d] = candles[d]);

  const maToday = safeCalcMA(today, period);
  const maPrev  = safeCalcMA(prev, period);
  if (maToday === null || maPrev === null) return false;

  return maToday < maPrev;
}

export const isMaSlopeUpDaily     = d => isMaSlopeUp(d, 25);
export const isMaSlopeDownDaily   = d => isMaSlopeDown(d, 25);
export const isMaSlopeUpWeekly    = w => isMaSlopeUp(w, 13);
export const isMaSlopeDownWeekly  = w => isMaSlopeDown(w, 13);
export const isMaSlopeUpMonthly   = m => isMaSlopeUp(m, 12);
export const isMaSlopeDownMonthly = m => isMaSlopeDown(m, 12);

// =========================================================
// パーフェクトオーダー / 逆PO（SAFE）
// =========================================================

function getMA(c, p) { return safeCalcMA(c, p); }

function isPerfectOrder(c, s, m, l) {
  const maS = getMA(c, s), maM = getMA(c, m), maL = getMA(c, l);
  if (maS === null || maM === null || maL === null) return false;
  return (maS > maM) && (maM > maL);
}

function isReversePerfectOrder(c, s, m, l) {
  const maS = getMA(c, s), maM = getMA(c, m), maL = getMA(c, l);
  if (maS === null || maM === null || maL === null) return false;
  return (maS < maM) && (maM < maL);
}

export const isPerfectOrderDaily        = d => isPerfectOrder(d, 5, 25, 75);
export const isReversePerfectOrderDaily = d => isReversePerfectOrder(d, 5, 25, 75);
export const isPerfectOrderWeekly       = w => isPerfectOrder(w, 5, 13, 26);
export const isReversePerfectOrderWeekly= w => isReversePerfectOrder(w, 5, 13, 26);
export const isPerfectOrderMonthly      = m => isPerfectOrder(m, 5, 12, 24);
export const isReversePerfectOrderMonthly = m => isReversePerfectOrder(m, 5, 12, 24);

// =========================================================
// PRE-PO / PRE-RPO（SAFE）
// =========================================================

function countReverseForPO(maS, maM, maL) {
  let r = 0;
  if (!(maS > maM)) r++;
  if (!(maM > maL)) r++;
  return r;
}

function countReverseForRPO(maS, maM, maL) {
  let r = 0;
  if (!(maS < maM)) r++;
  if (!(maM < maL)) r++;
  return r;
}

export function isPrePerfectOrder(daily) {
  const ma5  = safeCalcMA(daily, 5);
  const ma25 = safeCalcMA(daily, 25);
  const ma75 = safeCalcMA(daily, 75);
  if (ma5 === null || ma25 === null || ma75 === null) return false;
  return countReverseForPO(ma5, ma25, ma75) === 1;
}

export function isPreReversePerfectOrder(daily) {
  const ma5  = safeCalcMA(daily, 5);
  const ma25 = safeCalcMA(daily, 25);
  const ma75 = safeCalcMA(daily, 75);
  if (ma5 === null || ma25 === null || ma75 === null) return false;
  return countReverseForRPO(ma5, ma25, ma75) === 1;
}

// =========================================================
// MA 密集（SAFE）
// =========================================================

export function isMaCongestionUp(daily) {
  const ma5  = safeCalcMA(daily, 5);
  const ma25 = safeCalcMA(daily, 25);
  const ma75 = safeCalcMA(daily, 75);
  if (ma5 === null || ma25 === null || ma75 === null) return false;

  const max = Math.max(ma5, ma25, ma75);
  const min = Math.min(ma5, ma25, ma75);
  if ((max - min) / min >= 0.015) return false;

  return isMaSlopeUp(daily, 25);
}

export function isMaCongestionDown(daily) {
  const ma5  = safeCalcMA(daily, 5);
  const ma25 = safeCalcMA(daily, 25);
  const ma75 = safeCalcMA(daily, 75);
  if (ma5 === null || ma25 === null || ma75 === null) return false;

  const max = Math.max(ma5, ma25, ma75);
  const min = Math.min(ma5, ma25, ma75);
  if ((max - min) / min >= 0.015) return false;

  return isMaSlopeDown(daily, 25);
}

// =========================================================
// MA 間隔（SAFE）
// =========================================================

export function isMaSpreadUp(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 26) return false;

  const today = {}, prev = {};
  dates.forEach(d => today[d] = daily[d]);
  dates.slice(0, -1).forEach(d => prev[d] = daily[d]);

  const ma5Today  = safeCalcMA(today, 5);
  const ma25Today = safeCalcMA(today, 25);
  const ma5Prev   = safeCalcMA(prev, 5);
  const ma25Prev  = safeCalcMA(prev, 25);

  if ([ma5Today, ma25Today, ma5Prev, ma25Prev].some(x => x === null)) return false;

  const sToday = Math.abs(ma5Today - ma25Today);
  const sPrev  = Math.abs(ma5Prev  - ma25Prev);

  return sToday > sPrev;
}

export function isMaSpreadDown(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 26) return false;

  const today = {}, prev = {};
  dates.forEach(d => today[d] = daily[d]);
  dates.slice(0, -1).forEach(d => prev[d] = daily[d]);

  const ma5Today  = safeCalcMA(today, 5);
  const ma25Today = safeCalcMA(today, 25);
  const ma5Prev   = safeCalcMA(prev, 5);
  const ma25Prev  = safeCalcMA(prev, 25);

  if ([ma5Today, ma25Today, ma5Prev, ma25Prev].some(x => x === null)) return false;

  const sToday = Math.abs(ma5Today - ma25Today);
  const sPrev  = Math.abs(ma5Prev  - ma25Prev);

  return sToday < sPrev;
}

// =========================================================
// MA100 トレンド（SAFE）
// =========================================================

export function isMa100TrendUp(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 102) return false;

  const today = daily;
  const prev  = safeGetPrevCandles(daily, 1, 101);
  const prev2 = safeGetPrevCandles(daily, 2, 100);
  if (!prev || !prev2) return false;

  const ma100_today = safeCalcMA(today, 100);
  const ma100_prev  = safeCalcMA(prev, 100);
  const ma100_prev2 = safeCalcMA(prev2, 100);

  if ([ma100_today, ma100_prev, ma100_prev2].some(x => x === null)) return false;

  const slopeChange = (ma100_prev2 > ma100_prev) && (ma100_prev < ma100_today);
  if (!slopeChange) return false;

  const lastDate    = dates[dates.length - 1];
  const close_today = daily[lastDate].c;
  const ma25_today  = safeCalcMA(today, 25);
  if (ma25_today === null) return false;

  return (close_today > ma100_today) || (ma25_today > ma100_today);
}

export function isMa100TrendDown(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 102) return false;

  const today = daily;
  const prev  = safeGetPrevCandles(daily, 1, 101);
  const prev2 = safeGetPrevCandles(daily, 2, 100);
  if (!prev || !prev2) return false;

  const ma100_today = safeCalcMA(today, 100);
  const ma100_prev  = safeCalcMA(prev, 100);
  const ma100_prev2 = safeCalcMA(prev2, 100);

  if ([ma100_today, ma100_prev, ma100_prev2].some(x => x === null)) return false;

  const slopeChange = (ma100_prev2 < ma100_prev) && (ma100_prev > ma100_today);
  if (!slopeChange) return false;

  const lastDate    = dates[dates.length - 1];
  const close_today = daily[lastDate].c;
  const ma25_today  = safeCalcMA(today, 25);
  if (ma25_today === null) return false;

  return (close_today < ma100_today) || (ma25_today < ma100_today);
}

// =========================================================
// 下半身 / 逆下半身（SAFE）
// =========================================================

export function isKahanshin(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 6) return false;

  const today = dates[dates.length - 1];
  const prev  = dates[dates.length - 2];

  const o = daily[today].o;
  const c = daily[today].c;
  const cPrev = daily[prev].c;

  const ma5_today = safeCalcMA(daily, 5);
  if (ma5_today === null) return false;

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);
  const ma5_prev = safeCalcMA(prevCandles, 5);
  if (ma5_prev === null) return false;

  return (ma5_today > ma5_prev) && (o < c) && (cPrev < ma5_prev) && (c > ma5_today);
}

export function isGyakuKahanshin(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 6) return false;

  const today = dates[dates.length - 1];
  const prev  = dates[dates.length - 2];

  const o = daily[today].o;
  const c = daily[today].c;
  const cPrev = daily[prev].c;

  const ma5_today = safeCalcMA(daily, 5);
  if (ma5_today === null) return false;

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);
  const ma5_prev = safeCalcMA(prevCandles, 5);
  if (ma5_prev === null) return false;

  return (ma5_today < ma5_prev) && (o > c) && (cPrev > ma5_prev) && (c < ma5_today);
}

// =========================================================
// 5日線更新（SAFE）
// =========================================================

export function is5MaHighUpdate(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 10) return false;

  const ma5_today = safeCalcMA(daily, 5);
  if (ma5_today === null) return false;

  const prevDates = dates.slice(-6, -1);

  const maList = prevDates.map((_, idx) => {
    const tmp = {};
    dates.slice(0, dates.length - (5 - idx)).forEach(d => tmp[d] = daily[d]);
    return safeCalcMA(tmp, 5);
  }).filter(v => v !== null);

  if (maList.length === 0) return false;

  return ma5_today > Math.max(...maList);
}

export function is5MaLowUpdate(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 10) return false;

  const ma5_today = safeCalcMA(daily, 5);
  if (ma5_today === null) return false;

  const prevDates = dates.slice(-6, -1);

  const maList = prevDates.map((_, idx) => {
    const tmp = {};
    dates.slice(0, dates.length - (5 - idx)).forEach(d => tmp[d] = daily[d]);
    return safeCalcMA(tmp, 5);
  }).filter(v => v !== null);

  if (maList.length === 0) return false;

  return ma5_today < Math.min(...maList);
}

// =========================================================
// 酒田五法（SAFE）
// =========================================================

export function isSakataTripleTop(daily) {
  const arr = safeLast(daily, 5);
  if (!arr) return false;

  const [c1, , c3, , c5] = arr;
  const avg = (c1.h + c3.h + c5.h) / 3;
  const tol = avg * 0.01;

  return (
    Math.abs(c1.h - avg) < tol &&
    Math.abs(c3.h - avg) < tol &&
    Math.abs(c5.h - avg) < tol
  );
}

export function isSakataTripleBottom(daily) {
  const arr = safeLast(daily, 5);
  if (!arr) return false;

  const [c1, , c3, , c5] = arr;
  const avg = (c1.l + c3.l + c5.l) / 3;
  const tol = avg * 0.01;

  return (
    Math.abs(c1.l - avg) < tol &&
    Math.abs(c3.l - avg) < tol &&
    Math.abs(c5.l - avg) < tol
  );
}

export function isSakataSankuUp(daily) {
  const arr = safeLast(daily, 4);
  if (!arr) return false;

  const [c1, c2, c3, c4] = arr;
  return (c2.o > c1.h) && (c3.o > c2.h) && (c4.o > c3.h);
}

export function isSakataSankuDown(daily) {
  const arr = safeLast(daily, 4);
  if (!arr) return false;

  const [c1, c2, c3, c4] = arr;
  return (c2.o < c1.l) && (c3.o < c2.l) && (c4.o < c3.l);
}

export function isSakataSanpeiUp(daily) {
  const arr = safeLast(daily, 3);
  if (!arr) return false;

  const [c1, c2, c3] = arr;
  const bull = c => c.c > c.o;

  return (
    bull(c1) && bull(c2) && bull(c3) &&
    c2.o >= c1.o && c2.o <= c1.c &&
    c3.o >= c2.o && c3.o <= c2.c &&
    c2.c > c1.c && c3.c > c2.c
  );
}

export function isSakataSanpeiDown(daily) {
  const arr = safeLast(daily, 3);
  if (!arr) return false;

  const [c1, c2, c3] = arr;
  const bear = c => c.c < c.o;

  return (
    bear(c1) && bear(c2) && bear(c3) &&
    c2.o <= c1.o && c2.o >= c1.c &&
    c3.o <= c2.o && c3.o >= c2.c &&
    c2.c < c1.c && c3.c < c2.c
  );
}

export function isSakataSanpoUp(daily) {
  const arr = safeLast(daily, 5);
  if (!arr) return false;

  const [c1, c2, c3, c4, c5] = arr;
  const bull = c => c.c > c.o;
  const small = c => Math.abs(c.c - c.o) < (c1.c - c1.o) * 0.5;

  return (
    bull(c1) &&
    small(c2) && small(c3) && small(c4) &&
    bull(c5) &&
    c5.c > c1.c
  );
}

export function isSakataSanpoDown(daily) {
  const arr = safeLast(daily, 5);
  if (!arr) return false;

  const [c1, c2, c3, c4, c5] = arr;
  const bear = c => c.c < c.o;
  const small = c => Math.abs(c.c - c.o) < Math.abs(c1.c - c1.o) * 0.5;

  return (
    bear(c1) &&
    small(c2) && small(c3) && small(c4) &&
    bear(c5) &&
    c5.c < c1.c
  );
}

// =========================================================
// 三尊（Head and Shoulders）（SAFE）
// =========================================================

export function isHeadAndShoulders(daily) {
  const arr = safeLast(daily, 5);
  if (!arr) return false;

  const [c1, c2, c3, c4, c5] = arr;

  const h1 = c1.h; // 左肩
  const h2 = c3.h; // 頭
  const h3 = c5.h; // 右肩

  const l1 = c2.l; // 谷1
  const l2 = c4.l; // 谷2

  const cond1 = (h1 < h2) && (h3 < h2);
  const tolerance = h2 * 0.03;
  const cond2 = Math.abs(h1 - h3) < tolerance;
  const cond3 = (l1 < h1) && (l2 < h3);

  return cond1 && cond2 && cond3;
}

// =========================================================
// W底（Double Bottom）（SAFE）
// =========================================================

export function isDoubleBottom(daily) {
  const arr = safeLast(daily, 5);
  if (!arr) return false;

  const [c1, c2, c3, c4] = arr;

  const low1  = c1.l;
  const high1 = c2.h;
  const low2  = c3.l;
  const high2 = c4.h;

  const cond1 = (low1 < high1) && (low2 < high2);
  const tolerance = high1 * 0.03;
  const cond2 = Math.abs(low1 - low2) < tolerance;
  const cond3 = low2 >= low1 * 0.97;
  const cond4 = high2 > high1;

  return cond1 && cond2 && cond3 && cond4;
}

// =========================================================
// N大（上昇 N / 下降 N）（SAFE）
// =========================================================

export function isNichiDai(daily) {
  const arr = safeLast(daily, 4);
  if (!arr) return false;

  const [c1, c2, c3, c4] = arr;

  const low1  = c1.l;
  const high1 = c2.h;
  const low2  = c3.l;
  const high2 = c4.h;

  const cond1 = (low1 < high1) && (low2 < high2);
  const cond2 = low2 > low1;
  const cond3 = high2 > high1;

  return cond1 && cond2 && cond3;
}

export function isGyakuNichiDai(daily) {
  const arr = safeLast(daily, 4);
  if (!arr) return false;

  const [c1, c2, c3, c4] = arr;

  const high1 = c1.h;
  const low1  = c2.l;
  const high2 = c3.h;
  const low2  = c4.l;

  const cond1 = (high1 > low1) && (high2 > low2);
  const cond2 = high2 < high1;
  const cond3 = low2 < low1;

  return cond1 && cond2 && cond3;
}

// =========================================================
// ものわかれ（Monowakare Up / Down）（SAFE）
// =========================================================

export function isMonowakareUp(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 26) return false;

  const today = dates[dates.length - 1];
  const prev  = dates[dates.length - 2];

  const c_today = daily[today].c;
  const c_prev  = daily[prev].c;

  const ma5_today  = safeCalcMA(daily, 5);
  const ma25_today = safeCalcMA(daily, 25);

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);

  const ma5_prev   = safeCalcMA(prevCandles, 5);
  const ma25_prev  = safeCalcMA(prevCandles, 25);

  if ([ma5_today, ma25_today, ma5_prev, ma25_prev].some(x => x === null)) return false;

  const cond1 = (c_prev < ma25_prev) && (c_today > ma25_today);
  const cond2 = (ma5_prev < ma25_prev) && (ma5_today > ma25_today);

  return cond1 && cond2;
}

export function isMonowakareDown(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 26) return false;

  const today = dates[dates.length - 1];
  const prev  = dates[dates.length - 2];

  const c_today = daily[today].c;
  const c_prev  = daily[prev].c;

  const ma5_today  = safeCalcMA(daily, 5);
  const ma25_today = safeCalcMA(daily, 25);

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);

  const ma5_prev   = safeCalcMA(prevCandles, 5);
  const ma25_prev  = safeCalcMA(prevCandles, 25);

  if ([ma5_today, ma25_today, ma5_prev, ma25_prev].some(x => x === null)) return false;

  const cond1 = (c_prev > ma25_prev) && (c_today < ma25_today);
  const cond2 = (ma5_prev > ma25_prev) && (ma5_today < ma25_today);

  return cond1 && cond2;
}

// =========================================================
// ものわかれ（赤青交差：Monowakare Cross Up / Down）（赤青交差 SAFE）
// =========================================================

export function isMonowakareCrossUp(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 76) return false;

  const ma5_today  = safeCalcMA(daily, 5);
  const ma25_today = safeCalcMA(daily, 25);
  const ma75_today = safeCalcMA(daily, 75);

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);

  const ma5_prev   = safeCalcMA(prevCandles, 5);
  const ma25_prev  = safeCalcMA(prevCandles, 25);
  const ma75_prev  = safeCalcMA(prevCandles, 75);

  if ([ma5_today, ma25_today, ma75_today, ma5_prev, ma25_prev, ma75_prev].some(x => x === null))
    return false;

  const cond1 = (ma5_prev < ma25_prev) && (ma5_today > ma25_today);
  const cond2 = (ma25_prev < ma75_prev) && (ma25_today > ma75_today);

  return cond1 && cond2;
}

export function isMonowakareCrossDown(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 76) return false;

  const ma5_today  = safeCalcMA(daily, 5);
  const ma25_today = safeCalcMA(daily, 25);
  const ma75_today = safeCalcMA(daily, 75);

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);

  const ma5_prev   = safeCalcMA(prevCandles, 5);
  const ma25_prev  = safeCalcMA(prevCandles, 25);
  const ma75_prev  = safeCalcMA(prevCandles, 75);

  if ([ma5_today, ma25_today, ma75_today, ma5_prev, ma25_prev, ma75_prev].some(x => x === null))
    return false;

  const cond1 = (ma5_prev > ma25_prev) && (ma5_today < ma25_today);
  const cond2 = (ma25_prev > ma75_prev) && (ma25_today < ma75_today);

  return cond1 && cond2;
}

// =========================================================
// Rule9（日足）SAFE 実装
// =========================================================

export function computeRule9Daily(daily) {
  const dates = Object.keys(daily).sort();
  const n = dates.length;
  if (n < 3) {
    return { direction: null, count: 0, over9: false, over17: false, over23: false };
  }

  const ma5 = {};
  const ma100 = {};

  // MA が計算できる本数に達するまで null を入れる
  for (let i = 0; i < n; i++) {
    const sub = {};
    for (let j = 0; j <= i; j++) sub[dates[j]] = daily[dates[j]];

    ma5[dates[i]] = (i >= 4) ? calcMA(sub, 5) : null;
    ma100[dates[i]] = (i >= 99) ? calcMA(sub, 100) : null;
  }

  let ruleDir = null;
  let ruleStartIndex = null;
  let ruleCount = 0;

  let segmentLow = Infinity;
  let segmentLowIndex = null;

  let segmentHigh = -Infinity;
  let segmentHighIndex = null;

  let prevClose = daily[dates[0]].c;

  segmentLow = prevClose;
  segmentLowIndex = 0;
  segmentHigh = prevClose;
  segmentHighIndex = 0;

  for (let i = 1; i < n; i++) {
    const d = dates[i];
    const c = daily[d].c;

    const prevD = dates[i - 1];
    const prevMA5 = ma5[prevD];
    const prevMA100 = ma100[prevD];
    const todayMA5 = ma5[d];
    const todayMA100 = ma100[d];

    // MA が null の場合は判定不能 → スキップ
    if (prevMA5 === null || todayMA5 === null || prevMA100 === null || todayMA100 === null) {
      prevClose = c;
      continue;
    }

    const crossedUp = (prevClose < prevMA100) && (c > todayMA100);
    const crossedDown = (prevClose > prevMA100) && (c < todayMA100);

    if (crossedUp) {
      ruleDir = "up";
      ruleStartIndex = i;
      ruleCount = 1;
      segmentLow = c;
      segmentLowIndex = i;
      segmentHigh = c;
      segmentHighIndex = i;
      prevClose = c;
      continue;
    }

    if (crossedDown) {
      ruleDir = "down";
      ruleStartIndex = i;
      ruleCount = 1;
      segmentLow = c;
      segmentLowIndex = i;
      segmentHigh = c;
      segmentHighIndex = i;
      prevClose = c;
      continue;
    }

    const upMove = c > prevClose;
    const downMove = c < prevClose;

    if (c < segmentLow) {
      segmentLow = c;
      segmentLowIndex = i;
    }
    if (c > segmentHigh) {
      segmentHigh = c;
      segmentHighIndex = i;
    }

    if (ruleDir === "up") {
      if (c < todayMA5) {
        ruleDir = null;
        ruleCount = 0;
        prevClose = c;
        continue;
      }
      if (c >= prevClose) ruleCount++;
      else {
        ruleDir = null;
        ruleCount = 0;
      }
      prevClose = c;
      continue;
    }

    if (ruleDir === "down") {
      if (c > todayMA5) {
        ruleDir = null;
        ruleCount = 0;
        prevClose = c;
        continue;
      }
      if (c <= prevClose) ruleCount++;
      else {
        ruleDir = null;
        ruleCount = 0;
      }
      prevClose = c;
      continue;
    }

    if (upMove) {
      ruleDir = "up";
      ruleStartIndex = segmentLowIndex;
      ruleCount = i - segmentLowIndex + 1;
    } else if (downMove) {
      ruleDir = "down";
      ruleStartIndex = segmentHighIndex;
      ruleCount = i - segmentHighIndex + 1;
    }

    prevClose = c;
  }

  return {
    direction: ruleDir,
    count: ruleCount,
    over9: ruleCount >= 9,
    over17: ruleCount >= 17,
    over23: ruleCount >= 23,
  };
}

// =========================================================
// Rule9（週足）SAFE 実装
// =========================================================

export function computeRule9Weekly(weekly) {
  const dates = Object.keys(weekly).sort();
  const n = dates.length;
  if (n < 3) {
    return { direction: null, count: 0, over9: false, over17: false, over23: false };
  }

  const ma5 = {};
  const ma100 = {};

  // 日足と同じ修正
  for (let i = 0; i < n; i++) {
    const sub = {};
    for (let j = 0; j <= i; j++) sub[dates[j]] = weekly[dates[j]];

    ma5[dates[i]] = (i >= 4) ? calcMA(sub, 5) : null;
    ma100[dates[i]] = (i >= 99) ? calcMA(sub, 100) : null;
  }

  let ruleDir = null;
  let ruleStartIndex = null;
  let ruleCount = 0;

  let segmentLow = Infinity;
  let segmentLowIndex = null;

  let segmentHigh = -Infinity;
  let segmentHighIndex = null;

  let prevClose = weekly[dates[0]].c;

  segmentLow = prevClose;
  segmentLowIndex = 0;
  segmentHigh = prevClose;
  segmentHighIndex = 0;

  for (let i = 1; i < n; i++) {
    const d = dates[i];
    const c = weekly[d].c;

    const prevD = dates[i - 1];
    const prevMA5 = ma5[prevD];
    const prevMA100 = ma100[prevD];
    const todayMA5 = ma5[d];
    const todayMA100 = ma100[d];

    // MA が null のときはスキップ
    if (prevMA5 === null || todayMA5 === null || prevMA100 === null || todayMA100 === null) {
      prevClose = c;
      continue;
    }

    const crossedUp = (prevClose < prevMA100) && (c > todayMA100);
    const crossedDown = (prevClose > prevMA100) && (c < todayMA100);

    if (crossedUp) {
      ruleDir = "up";
      ruleStartIndex = i;
      ruleCount = 1;
      segmentLow = c;
      segmentLowIndex = i;
      segmentHigh = c;
      segmentHighIndex = i;
      prevClose = c;
      continue;
    }

    if (crossedDown) {
      ruleDir = "down";
      ruleStartIndex = i;
      ruleCount = 1;
      segmentLow = c;
      segmentLowIndex = i;
      segmentHigh = c;
      segmentHighIndex = i;
      prevClose = c;
      continue;
    }

    const upMove = c > prevClose;
    const downMove = c < prevClose;

    if (c < segmentLow) {
      segmentLow = c;
      segmentLowIndex = i;
    }
    if (c > segmentHigh) {
      segmentHigh = c;
      segmentHighIndex = i;
    }

    if (ruleDir === "up") {
      if (c < todayMA5) {
        ruleDir = null;
        ruleCount = 0;
        prevClose = c;
        continue;
      }
      if (c >= prevClose) ruleCount++;
      else {
        ruleDir = null;
        ruleCount = 0;
      }
      prevClose = c;
      continue;
    }

    if (ruleDir === "down") {
      if (c > todayMA5) {
        ruleDir = null;
        ruleCount = 0;
        prevClose = c;
        continue;
      }
      if (c <= prevClose) ruleCount++;
      else {
        ruleDir = null;
        ruleCount = 0;
      }
      prevClose = c;
      continue;
    }

    if (upMove) {
      ruleDir = "up";
      ruleStartIndex = segmentLowIndex;
      ruleCount = i - segmentLowIndex + 1;
    } else if (downMove) {
      ruleDir = "down";
      ruleStartIndex = segmentHighIndex;
      ruleCount = i - segmentHighIndex + 1;
    }

    prevClose = c;
  }

  return {
    direction: ruleDir,
    count: ruleCount,
    over9: ruleCount >= 9,
    over17: ruleCount >= 17,
    over23: ruleCount >= 23,
  };
}

// =========================================================
// Rule9 ラッパー関数（SAFE）
// =========================================================

// 日足：上昇 Rule9
export const isRule9DailyUp9  = d => computeRule9Daily(d).direction === "up"   && computeRule9Daily(d).over9;
export const isRule9DailyUp17 = d => computeRule9Daily(d).direction === "up"   && computeRule9Daily(d).over17;
export const isRule9DailyUp23 = d => computeRule9Daily(d).direction === "up"   && computeRule9Daily(d).over23;

// 日足：下降 Rule9
export const isRule9DailyDown9  = d => computeRule9Daily(d).direction === "down" && computeRule9Daily(d).over9;
export const isRule9DailyDown17 = d => computeRule9Daily(d).direction === "down" && computeRule9Daily(d).over17;
export const isRule9DailyDown23 = d => computeRule9Daily(d).direction === "down" && computeRule9Daily(d).over23;

// 週足：上昇 Rule9
export const isRule9WeeklyUp9  = w => computeRule9Weekly(w).direction === "up"   && computeRule9Weekly(w).over9;
export const isRule9WeeklyUp17 = w => computeRule9Weekly(w).direction === "up"   && computeRule9Weekly(w).over17;
export const isRule9WeeklyUp23 = w => computeRule9Weekly(w).direction === "up"   && computeRule9Weekly(w).over23;

// 週足：下降 Rule9
export const isRule9WeeklyDown9  = w => computeRule9Weekly(w).direction === "down" && computeRule9Weekly(w).over9;
export const isRule9WeeklyDown17 = w => computeRule9Weekly(w).direction === "down" && computeRule9Weekly(w).over17;
export const isRule9WeeklyDown23 = w => computeRule9Weekly(w).direction === "down" && computeRule9Weekly(w).over23;
