/********************************************************************************************
 * heuristics_conditions.js
 *
 * 特記事項：
 *   - TECH_OVERHEAT のみ仕様未確定のため TODO（常に false）
 *   - すべての MA 計算は safeCalcMA による SAFE 実装
 *   - すべてのローソク足参照は SAFE 化済み
 ********************************************************************************************/

/* ==========================================================================================
   共通関数
========================================================================================== */

function calcMA(candles, period) {
  const dates = Object.keys(candles).sort();
  const closes = dates.map(d => candles[d].c);
  if (closes.length < period) throw new Error(`Not enough candles for MA${period}`);
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

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
  sliced.forEach(d => (obj[d] = candles[d]));
  return obj;
}


/* ==========================================================================================
   MA 傾き（5/25/75, 5/13/26, 5/12/24）
========================================================================================== */

function isMaSlopeUp(candles, period) {
  const dates = Object.keys(candles).sort();
  if (dates.length < period + 1) return false;

  const today = {};
  const prev = {};
  dates.forEach(d => (today[d] = candles[d]));
  dates.slice(0, -1).forEach(d => (prev[d] = candles[d]));

  const maToday = safeCalcMA(today, period);
  const maPrev = safeCalcMA(prev, period);
  if (maToday === null || maPrev === null) return false;

  return maToday > maPrev;
}

function isMaSlopeDown(candles, period) {
  const dates = Object.keys(candles).sort();
  if (dates.length < period + 1) return false;

  const today = {};
  const prev = {};
  dates.forEach(d => (today[d] = candles[d]));
  dates.slice(0, -1).forEach(d => (prev[d] = candles[d]));

  const maToday = safeCalcMA(today, period);
  const maPrev = safeCalcMA(prev, period);
  if (maToday === null || maPrev === null) return false;

  return maToday < maPrev;
}

const isMaSlopeUpDaily = d => isMaSlopeUp(d, 25);
const isMaSlopeDownDaily = d => isMaSlopeDown(d, 25);
const isMaSlopeUpWeekly = w => isMaSlopeUp(w, 13);
const isMaSlopeDownWeekly = w => isMaSlopeDown(w, 13);
const isMaSlopeUpMonthly = m => isMaSlopeUp(m, 12);
const isMaSlopeDownMonthly = m => isMaSlopeDown(m, 12);


/* ==========================================================================================
   MA POSITION（株価 > 短期 > 中期 > 長期）
========================================================================================== */

function isMaPositionDaily(daily) {
  const maS = safeCalcMA(daily, 5);
  const maM = safeCalcMA(daily, 25);
  const maL = safeCalcMA(daily, 75);
  if (maS === null || maM === null || maL === null) return "flat";

  const dates = Object.keys(daily).sort();
  const last = dates[dates.length - 1];
  const price = daily[last].c;

  if (price > maS && maS > maM && maM > maL) return "up";
  if (maL > maM && maM > maS && maS > price) return "down";
  return "flat";
}

function isMaPositionWeekly(weekly) {
  const maS = safeCalcMA(weekly, 5);
  const maM = safeCalcMA(weekly, 13);
  const maL = safeCalcMA(weekly, 26);
  if (maS === null || maM === null || maL === null) return "flat";

  const dates = Object.keys(weekly).sort();
  const last = dates[dates.length - 1];
  const price = weekly[last].c;

  if (price > maS && maS > maM && maM > maL) return "up";
  if (maL > maM && maM > maS && maS > price) return "down";
  return "flat";
}

function isMaPositionMonthly(monthly) {
  const maS = safeCalcMA(monthly, 5);
  const maM = safeCalcMA(monthly, 12);
  const maL = safeCalcMA(monthly, 24);
  if (maS === null || maM === null || maL === null) return "flat";

  const dates = Object.keys(monthly).sort();
  const last = dates[dates.length - 1];
  const price = monthly[last].c;

  if (price > maS && maS > maM && maM > maL) return "up";
  if (maL > maM && maM > maS && maS > price) return "down";
  return "flat";
}


/* ==========================================================================================
   パーフェクトオーダー / 逆パーフェクトオーダー
========================================================================================== */

function isPerfectOrder(candles, shortP, midP, longP) {
  const maS = safeCalcMA(candles, shortP);
  const maM = safeCalcMA(candles, midP);
  const maL = safeCalcMA(candles, longP);
  if (maS === null || maM === null || maL === null) return false;

  return maS > maM && maM > maL;
}

function isReversePerfectOrder(candles, shortP, midP, longP) {
  const maS = safeCalcMA(candles, shortP);
  const maM = safeCalcMA(candles, midP);
  const maL = safeCalcMA(candles, longP);
  if (maS === null || maM === null || maL === null) return false;

  return maS < maM && maM < maL;
}

// 日足
const isPerfectOrderDaily = d => isPerfectOrder(d, 5, 25, 75);
const isReversePerfectOrderDaily = d => isReversePerfectOrder(d, 5, 25, 75);

// 週足
const isPerfectOrderWeekly = w => isPerfectOrder(w, 5, 13, 26);
const isReversePerfectOrderWeekly = w => isReversePerfectOrder(w, 5, 13, 26);

// 月足
const isPerfectOrderMonthly = m => isPerfectOrder(m, 5, 12, 24);
const isReversePerfectOrderMonthly = m => isReversePerfectOrder(m, 5, 12, 24);


/* ==========================================================================================
   PRE-PO / PRE-RPO
========================================================================================== */

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

function isPrePerfectOrderDaily(daily) {
  const ma5 = safeCalcMA(daily, 5);
  const ma25 = safeCalcMA(daily, 25);
  const ma75 = safeCalcMA(daily, 75);
  if (ma5 === null || ma25 === null || ma75 === null) return false;
  return countReverseForPO(ma5, ma25, ma75) === 1;
}

function isPreReversePerfectOrderDaily(daily) {
  const ma5 = safeCalcMA(daily, 5);
  const ma25 = safeCalcMA(daily, 25);
  const ma75 = safeCalcMA(daily, 75);
  if (ma5 === null || ma25 === null || ma75 === null) return false;
  return countReverseForRPO(ma5, ma25, ma75) === 1;
}

function isPrePerfectOrderWeekly(weekly) {
  const ma5 = safeCalcMA(weekly, 5);
  const ma13 = safeCalcMA(weekly, 13);
  const ma26 = safeCalcMA(weekly, 26);
  if (ma5 === null || ma13 === null || ma26 === null) return false;
  return countReverseForPO(ma5, ma13, ma26) === 1;
}

function isPreReversePerfectOrderWeekly(weekly) {
  const ma5 = safeCalcMA(weekly, 5);
  const ma13 = safeCalcMA(weekly, 13);
  const ma26 = safeCalcMA(weekly, 26);
  if (ma5 === null || ma13 === null || ma26 === null) return false;
  return countReverseForRPO(ma5, ma13, ma26) === 1;
}

function isPrePerfectOrderMonthly(monthly) {
  const ma5 = safeCalcMA(monthly, 5);
  const ma12 = safeCalcMA(monthly, 12);
  const ma24 = safeCalcMA(monthly, 24);
  if (ma5 === null || ma12 === null || ma24 === null) return false;
  return countReverseForPO(ma5, ma12, ma24) === 1;
}

function isPreReversePerfectOrderMonthly(monthly) {
  const ma5 = safeCalcMA(monthly, 5);
  const ma12 = safeCalcMA(monthly, 12);
  const ma24 = safeCalcMA(monthly, 24);
  if (ma5 === null || ma12 === null || ma24 === null) return false;
  return countReverseForRPO(ma5, ma12, ma24) === 1;
}


/* ==========================================================================================
   MA 密集（5/10/20）
========================================================================================== */

function isMaCongestion(daily) {
  const ma5 = safeCalcMA(daily, 5);
  const ma10 = safeCalcMA(daily, 10);
  const ma20 = safeCalcMA(daily, 20);
  if (ma5 === null || ma10 === null || ma20 === null) return false;

  const max = Math.max(ma5, ma10, ma20);
  const min = Math.min(ma5, ma10, ma20);
  if ((max - min) / min >= 0.015) return false;

  return true;
}


/* ==========================================================================================
   MA 間隔（Spread）
========================================================================================== */

function isMaSpreadUp(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 26) return "flat";

  const today = {};
  const prev = {};
  dates.forEach(d => (today[d] = daily[d]));
  dates.slice(0, -1).forEach(d => (prev[d] = daily[d]));

  const ma5Today = safeCalcMA(today, 5);
  const ma25Today = safeCalcMA(today, 25);
  const ma5Prev = safeCalcMA(prev, 5);
  const ma25Prev = safeCalcMA(prev, 25);

  if ([ma5Today, ma25Today, ma5Prev, ma25Prev].some(x => x === null)) return "flat";

  const sToday = Math.abs(ma5Today - ma25Today);
  const sPrev = Math.abs(ma5Prev - ma25Prev);

  if (sToday > sPrev) return "up";
  if (sToday < sPrev) return "down";
  return "flat";
}


/* ==========================================================================================
   MA100 トレンド
========================================================================================== */

function isMa100Trend(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 102) return "flat";

  const today = daily;
  const prev = safeGetPrevCandles(daily, 1, 101);
  const prev2 = safeGetPrevCandles(daily, 2, 100);
  if (!prev || !prev2) return "flat";

  const ma100_today = safeCalcMA(today, 100);
  const ma100_prev = safeCalcMA(prev, 100);
  const ma100_prev2 = safeCalcMA(prev2, 100);

  if ([ma100_today, ma100_prev, ma100_prev2].some(x => x === null)) return "flat";

  const lastDate = dates[dates.length - 1];
  const close_today = daily[lastDate].c;
  const ma25_today = safeCalcMA(today, 25);
  if (ma25_today === null) return "flat";

  const slopeUp = ma100_prev2 < ma100_prev && ma100_prev < ma100_today;
  const slopeDown = ma100_prev2 > ma100_prev && ma100_prev > ma100_today;

  if (slopeUp && (close_today > ma100_today || ma25_today > ma100_today)) return "up";
  if (slopeDown && (close_today < ma100_today || ma25_today < ma100_today)) return "down";
  return "flat";
}

/* ==========================================================================================
   下半身 / 逆下半身
========================================================================================== */

function isKahanshin(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 6) return false;

  const today = dates[dates.length - 1];
  const prev = dates[dates.length - 2];

  const o = daily[today].o;
  const c = daily[today].c;
  const cPrev = daily[prev].c;

  const ma5_today = safeCalcMA(daily, 5);
  if (ma5_today === null) return false;

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => (prevCandles[d] = daily[d]));
  const ma5_prev = safeCalcMA(prevCandles, 5);
  if (ma5_prev === null) return false;

  return ma5_today > ma5_prev && o < c && cPrev < ma5_prev && c > ma5_today;
}

function isGyakuKahanshin(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 6) return false;

  const today = dates[dates.length - 1];
  const prev = dates[dates.length - 2];

  const o = daily[today].o;
  const c = daily[today].c;
  const cPrev = daily[prev].c;

  const ma5_today = safeCalcMA(daily, 5);
  if (ma5_today === null) return false;

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => (prevCandles[d] = daily[d]));
  const ma5_prev = safeCalcMA(prevCandles, 5);
  if (ma5_prev === null) return false;

  return ma5_today < ma5_prev && o > c && cPrev > ma5_prev && c < ma5_today;
}


/* ==========================================================================================
   5日線更新
========================================================================================== */

function is5MaHighUpdate(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 10) return false;

  const ma5_today = safeCalcMA(daily, 5);
  if (ma5_today === null) return false;

  const prevDates = dates.slice(-6, -1);

  const maList = prevDates
    .map((_, idx) => {
      const tmp = {};
      dates.slice(0, dates.length - (5 - idx)).forEach(d => (tmp[d] = daily[d]));
      return safeCalcMA(tmp, 5);
    })
    .filter(v => v !== null);

  if (maList.length === 0) return false;

  return ma5_today > Math.max(...maList);
}

function is5MaLowUpdate(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 10) return false;

  const ma5_today = safeCalcMA(daily, 5);
  if (ma5_today === null) return false;

  const prevDates = dates.slice(-6, -1);

  const maList = prevDates
    .map((_, idx) => {
      const tmp = {};
      dates.slice(0, dates.length - (5 - idx)).forEach(d => (tmp[d] = daily[d]));
      return safeCalcMA(tmp, 5);
    })
    .filter(v => v !== null);

  if (maList.length === 0) return false;

  return ma5_today < Math.min(...maList);
}


/* ==========================================================================================
   酒田五法（三山 / 三川 / 三空 / 三兵 / 三法）
========================================================================================== */

function isSakataTripleTop(daily) {
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

function isSakataTripleBottom(daily) {
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

function isSakataSankuUp(daily) {
  const arr = safeLast(daily, 4);
  if (!arr) return false;

  const [c1, c2, c3, c4] = arr;
  return c2.o > c1.h && c3.o > c2.h && c4.o > c3.h;
}

function isSakataSankuDown(daily) {
  const arr = safeLast(daily, 4);
  if (!arr) return false;

  const [c1, c2, c3, c4] = arr;
  return c2.o < c1.l && c3.o < c2.l && c4.o < c3.l;
}

function isSakataSanpeiUp(daily) {
  const arr = safeLast(daily, 3);
  if (!arr) return false;

  const [c1, c2, c3] = arr;
  const bull = c => c.c > c.o;

  return (
    bull(c1) &&
    bull(c2) &&
    bull(c3) &&
    c2.o >= c1.o &&
    c2.o <= c1.c &&
    c3.o >= c2.o &&
    c3.o <= c2.c &&
    c2.c > c1.c &&
    c3.c > c2.c
  );
}

function isSakataSanpeiDown(daily) {
  const arr = safeLast(daily, 3);
  if (!arr) return false;

  const [c1, c2, c3] = arr;
  const bear = c => c.c < c.o;

  return (
    bear(c1) &&
    bear(c2) &&
    bear(c3) &&
    c2.o <= c1.o &&
    c2.o >= c1.c &&
    c3.o <= c2.o &&
    c3.o >= c2.c &&
    c2.c < c1.c &&
    c3.c < c2.c
  );
}

function isSakataSanpoUp(daily) {
  const arr = safeLast(daily, 5);
  if (!arr) return false;

  const [c1, c2, c3, c4, c5] = arr;
  const bull = c => c.c > c.o;
  const small = c => Math.abs(c.c - c.o) < (c1.c - c1.o) * 0.5;

  return bull(c1) && small(c2) && small(c3) && small(c4) && bull(c5) && c5.c > c1.c;
}

function isSakataSanpoDown(daily) {
  const arr = safeLast(daily, 5);
  if (!arr) return false;

  const [c1, c2, c3, c4, c5] = arr;
  const bear = c => c.c < c.o;
  const small = c => Math.abs(c.c - c.o) < Math.abs(c1.c - c1.o) * 0.5;

  return bear(c1) && small(c2) && small(c3) && small(c4) && bear(c5) && c5.c < c1.c;
}


/* ==========================================================================================
   三尊（Head and Shoulders）
========================================================================================== */

function isHeadAndShoulders(daily) {
  const arr = safeLast(daily, 5);
  if (!arr) return false;

  const [c1, c2, c3, c4, c5] = arr;

  const h1 = c1.h;
  const h2 = c3.h;
  const h3 = c5.h;

  const l1 = c2.l;
  const l2 = c4.l;

  const cond1 = h1 < h2 && h3 < h2;
  const tolerance = h2 * 0.03;
  const cond2 = Math.abs(h1 - h3) < tolerance;
  const cond3 = l1 < h1 && l2 < h3;

  return cond1 && cond2 && cond3;
}


/* ==========================================================================================
   W底（Double Bottom）
========================================================================================== */

function isDoubleBottom(daily) {
  const arr = safeLast(daily, 5);
  if (!arr) return false;

  const [c1, c2, c3, c4] = arr;

  const low1 = c1.l;
  const high1 = c2.h;
  const low2 = c3.l;
  const high2 = c4.h;

  const cond1 = low1 < high1 && low2 < high2;
  const tolerance = high1 * 0.03;
  const cond2 = Math.abs(low1 - low2) < tolerance;
  const cond3 = low2 >= low1 * 0.97;
  const cond4 = high2 > high1;

  return cond1 && cond2 && cond3 && cond4;
}


/* ==========================================================================================
   N大（上昇 N / 下降 N）
========================================================================================== */

function isNichiDai(daily) {
  const arr = safeLast(daily, 4);
  if (!arr) return false;

  const [c1, c2, c3, c4] = arr;

  const low1 = c1.l;
  const high1 = c2.h;
  const low2 = c3.l;
  const high2 = c4.h;

  const cond1 = low1 < high1 && low2 < high2;
  const cond2 = low2 > low1;
  const cond3 = high2 > high1;

  return cond1 && cond2 && cond3;
}

function isGyakuNichiDai(daily) {
  const arr = safeLast(daily, 4);
  if (!arr) return false;

  const [c1, c2, c3, c4] = arr;

  const high1 = c1.h;
  const low1 = c2.l;
  const high2 = c3.h;
  const low2 = c4.l;

  const cond1 = high1 > low1 && high2 > low2;
  const cond2 = high2 < high1;
  const cond3 = low2 < low1;

  return cond1 && cond2 && cond3;
}


/* ==========================================================================================
   ものわかれ（Monowakare）
========================================================================================== */

function isMonowakareUp(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 26) return false;

  const today = dates[dates.length - 1];
  const prev = dates[dates.length - 2];

  const c_today = daily[today].c;
  const c_prev = daily[prev].c;

  const ma5_today = safeCalcMA(daily, 5);
  const ma25_today = safeCalcMA(daily, 25);

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => (prevCandles[d] = daily[d]));

  const ma5_prev = safeCalcMA(prevCandles, 5);
  const ma25_prev = safeCalcMA(prevCandles, 25);

  if ([ma5_today, ma25_today, ma5_prev, ma25_prev].some(x => x === null)) return false;

  const cond1 = c_prev < ma25_prev && c_today > ma25_today;
  const cond2 = ma5_prev < ma25_prev && ma5_today > ma25_today;

  return cond1 && cond2;
}

function isMonowakareDown(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 26) return false;

  const today = dates[dates.length - 1];
  const prev = dates[dates.length - 2];

  const c_today = daily[today].c;
  const c_prev = daily[prev].c;

  const ma5_today = safeCalcMA(daily, 5);
  const ma25_today = safeCalcMA(daily, 25);

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => (prevCandles[d] = daily[d]));

  const ma5_prev = safeCalcMA(prevCandles, 5);
  const ma25_prev = safeCalcMA(prevCandles, 25);

  if ([ma5_today, ma25_today, ma5_prev, ma25_prev].some(x => x === null)) return false;

  const cond1 = c_prev > ma25_prev && c_today < ma25_today;
  const cond2 = ma5_prev > ma25_prev && ma5_today < ma25_today;

  return cond1 && cond2;
}


/* ==========================================================================================
   ものわかれ（赤青交差：5MA × 20MA）
========================================================================================== */

function isMonowakareRedBlueCrossUp(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 76) return false;

  const ma5_today = safeCalcMA(daily, 5);
  const ma25_today = safeCalcMA(daily, 25);
  const ma75_today = safeCalcMA(daily, 75);

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => (prevCandles[d] = daily[d]));

  const ma5_prev = safeCalcMA(prevCandles, 5);
  const ma25_prev = safeCalcMA(prevCandles, 25);
  const ma75_prev = safeCalcMA(prevCandles, 75);

  if ([ma5_today, ma25_today, ma75_today, ma5_prev, ma25_prev, ma75_prev].some(x => x === null))
    return false;

  const cond1 = ma5_prev < ma25_prev && ma5_today > ma25_today;
  const cond2 = ma25_prev < ma75_prev && ma25_today > ma75_today;

  return cond1 && cond2;
}

function isMonowakareRedBlueCrossDown(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 76) return false;

  const ma5_today = safeCalcMA(daily, 5);
  const ma25_today = safeCalcMA(daily, 25);
  const ma75_today = safeCalcMA(daily, 75);

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => (prevCandles[d] = daily[d]));

  const ma5_prev = safeCalcMA(prevCandles, 5);
  const ma25_prev = safeCalcMA(prevCandles, 25);
  const ma75_prev = safeCalcMA(prevCandles, 75);

  if ([ma5_today, ma25_today, ma75_today, ma5_prev, ma25_prev, ma75_prev].some(x => x === null))
    return false;

  const cond1 = ma5_prev > ma25_prev && ma5_today < ma25_today;
  const cond2 = ma25_prev > ma75_prev && ma25_today < ma75_today;

  return cond1 && cond2;
}

/* ==========================================================================================
   Rule9（日足 / 週足）SAFE（direction / count のみ）
========================================================================================== */

function computeRule9Daily(daily) {
  const dates = Object.keys(daily).sort();
  const n = dates.length;
  if (n < 3) return { direction: null, count: 0 };

  const ma5 = {};
  const ma100 = {};

  for (let i = 0; i < n; i++) {
    const sub = {};
    for (let j = 0; j <= i; j++) sub[dates[j]] = daily[dates[j]];
    ma5[dates[i]] = i >= 4 ? calcMA(sub, 5) : null;
    ma100[dates[i]] = i >= 99 ? calcMA(sub, 100) : null;
  }

  let ruleDir = null;
  let ruleCount = 0;

  let segmentLow = daily[dates[0]].c;
  let segmentLowIndex = 0;

  let segmentHigh = daily[dates[0]].c;
  let segmentHighIndex = 0;

  let prevClose = daily[dates[0]].c;

  for (let i = 1; i < n; i++) {
    const d = dates[i];
    const c = daily[d].c;

    const prevD = dates[i - 1];
    const prevMA5 = ma5[prevD];
    const prevMA100 = ma100[prevD];
    const todayMA5 = ma5[d];
    const todayMA100 = ma100[d];

    if (prevMA5 === null || todayMA5 === null || prevMA100 === null || todayMA100 === null) {
      prevClose = c;
      continue;
    }

    const crossedUp = prevClose < prevMA100 && c > todayMA100;
    const crossedDown = prevClose > prevMA100 && c < todayMA100;

    if (crossedUp) {
      ruleDir = "up";
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
      ruleCount = i - segmentLowIndex + 1;
    } else if (downMove) {
      ruleDir = "down";
      ruleCount = i - segmentHighIndex + 1;
    }

    prevClose = c;
  }

  return { direction: ruleDir, count: ruleCount };
}

function computeRule9Weekly(weekly) {
  const dates = Object.keys(weekly).sort();
  const n = dates.length;
  if (n < 3) return { direction: null, count: 0 };

  const ma5 = {};
  const ma100 = {};

  // MA5 / MA100 をローソク足の進行に合わせて逐次計算
  for (let i = 0; i < n; i++) {
    const sub = {};
    for (let j = 0; j <= i; j++) sub[dates[j]] = weekly[dates[j]];

    ma5[dates[i]] = i >= 4 ? calcMA(sub, 5) : null;
    ma100[dates[i]] = i >= 99 ? calcMA(sub, 100) : null;
  }

  let ruleDir = null;
  let ruleCount = 0;

  let segmentLow = weekly[dates[0]].c;
  let segmentLowIndex = 0;

  let segmentHigh = weekly[dates[0]].c;
  let segmentHighIndex = 0;

  let prevClose = weekly[dates[0]].c;

  for (let i = 1; i < n; i++) {
    const d = dates[i];
    const c = weekly[d].c;

    const prevD = dates[i - 1];
    const prevMA5 = ma5[prevD];
    const prevMA100 = ma100[prevD];
    const todayMA5 = ma5[d];
    const todayMA100 = ma100[d];

    // MA が未計算の期間はスキップ
    if (prevMA5 === null || todayMA5 === null || prevMA100 === null || todayMA100 === null) {
      prevClose = c;
      continue;
    }

    // 100週線をまたいだ場合 → カウントリセット
    const crossedUp = prevClose < prevMA100 && c > todayMA100;
    const crossedDown = prevClose > prevMA100 && c < todayMA100;

    if (crossedUp) {
      ruleDir = "up";
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

    // セグメント更新
    if (c < segmentLow) {
      segmentLow = c;
      segmentLowIndex = i;
    }
    if (c > segmentHigh) {
      segmentHigh = c;
      segmentHighIndex = i;
    }

    // 上昇カウント中
    if (ruleDir === "up") {
      // 5週線を割ったら終了
      if (c < todayMA5) {
        ruleDir = null;
        ruleCount = 0;
        prevClose = c;
        continue;
      }
      // 終値が前週以上ならカウント継続
      if (c >= prevClose) ruleCount++;
      else {
        ruleDir = null;
        ruleCount = 0;
      }
      prevClose = c;
      continue;
    }

    // 下降カウント中
    if (ruleDir === "down") {
      // 5週線を上抜けたら終了
      if (c > todayMA5) {
        ruleDir = null;
        ruleCount = 0;
        prevClose = c;
        continue;
      }
      // 終値が前週以下ならカウント継続
      if (c <= prevClose) ruleCount++;
      else {
        ruleDir = null;
        ruleCount = 0;
      }
      prevClose = c;
      continue;
    }

    // 新規カウント開始（100週線をまたいでいない通常ケース）
    if (upMove) {
      ruleDir = "up";
      ruleCount = i - segmentLowIndex + 1;
    } else if (downMove) {
      ruleDir = "down";
      ruleCount = i - segmentHighIndex + 1;
    }

    prevClose = c;
  }

  return { direction: ruleDir, count: ruleCount };
}

/* ==========================================================================================
   ボリンジャーバンド ゾーン判定（0σ / 1σ / 2σ / 3σ）
========================================================================================== */

function getBbZone(candles) {
  const dates = Object.keys(candles).sort();
  if (dates.length < 21) return null;

  const last = dates[dates.length - 1];
  const price = candles[last].c;

  const closes = dates.slice(-20).map(d => candles[d].c);
  const mean = closes.reduce((a, b) => a + b, 0) / 20;
  const variance = closes.reduce((a, b) => a + (b - mean) ** 2, 0) / 20;
  const sigma = Math.sqrt(variance);

  const upper1 = mean + sigma;
  const lower1 = mean - sigma;
  const upper2 = mean + sigma * 2;
  const lower2 = mean - sigma * 2;
  const upper3 = mean + sigma * 3;
  const lower3 = mean - sigma * 3;

  if (price > upper3 || price < lower3) return "3σ";
  if (price > upper2 || price < lower2) return "2σ";
  if (price > upper1 || price < lower1) return "1σ";
  return "0σ";
}

function getBbZoneBreak(candles) {
  const dates = Object.keys(candles).sort();
  if (dates.length < 22) return null;

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => (prevCandles[d] = candles[d]));

  const prevZone = getBbZone(prevCandles);
  const currZone = getBbZone(candles);

  if (!prevZone || !currZone) return null;
  if (prevZone !== currZone) return `${prevZone} → ${currZone}`;
  return null;
}

const isBbZoneBreakDaily = d => getBbZoneBreak(d) !== null;
const isBbZoneBreakWeekly = w => getBbZoneBreak(w) !== null;
const isBbZoneBreakMonthly = m => getBbZoneBreak(m) !== null;


/* ==========================================================================================
   BOX RANGE（横ばい）
========================================================================================== */

function isBoxRange(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 120) return false;

  const ma100 = safeCalcMA(daily, 100);
  if (ma100 === null) return false;

  const recent = dates.slice(-20);
  const prices = recent.map(d => daily[d].c);

  const withinRange = prices.filter(p => Math.abs(p - ma100) / ma100 <= 0.015).length;
  if (withinRange < 15) return false;

  let crossCount = 0;
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];

    const prevIdx = dates.indexOf(prev);
    const currIdx = dates.indexOf(curr);

    const prevSlice = {};
    dates.slice(0, prevIdx + 1).forEach(d => (prevSlice[d] = daily[d]));
    const currSlice = {};
    dates.slice(0, currIdx + 1).forEach(d => (currSlice[d] = daily[d]));

    const ma5_prev = safeCalcMA(prevSlice, 5);
    const ma5_curr = safeCalcMA(currSlice, 5);

    if (ma5_prev === null || ma5_curr === null) continue;

    const prevSide = ma5_prev > ma100 ? 1 : -1;
    const currSide = ma5_curr > ma100 ? 1 : -1;

    if (prevSide !== currSide) crossCount++;
  }

  return crossCount >= 5;
}


/* ==========================================================================================
   OVERHEAT（過熱）— TODO（仕様未確定）
========================================================================================== */

function isOverheat(daily) {
  // TODO: 2026-06-19 泰長より仕様未確定。
  // RSI / 乖離率 / BB / MA など複数候補があるため、
  // 現時点では骨組みのみ実装し、常に false を返す。
  return false;
}


/* ==========================================================================================
   グランビル（上昇 / 下降）
========================================================================================== */

function computeGranville(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 80) return { direction: null, count: null };

  const ma75 = safeCalcMA(daily, 75);
  if (ma75 === null) return { direction: null, count: null };

  const last = dates[dates.length - 1];
  const prev = dates[dates.length - 2];

  const c = daily[last].c;
  const cp = daily[prev].c;

  const prevSlice = {};
  dates.slice(0, -1).forEach(d => (prevSlice[d] = daily[d]));
  const ma75_prev = safeCalcMA(prevSlice, 75);

  // 上昇相場 1回目
  if (ma75_prev !== null && ma75 >= ma75_prev) {
    if (c > ma75 && cp <= ma75) return { direction: "up", count: 1 };
  }

  // 上昇相場 2回目
  if (cp < ma75 && c > ma75) return { direction: "up", count: 2 };

  // 上昇相場 3回目
  if (c > ma75 * 1.05) return { direction: "up", count: 3 };

  // 上昇相場 4回目
  if (cp > ma75 && c < ma75) return { direction: "up", count: 4 };

  // 下降相場 1回目
  if (cp > c && cp > ma75 && c > ma75) return { direction: "down", count: 1 };


  // 下降相場 2回目
  if (ma75_prev !== null && ma75 < ma75_prev) {
    if (cp > ma75 && c < ma75) return { direction: "down", count: 2 };
  }

  // 下降相場 3回目
  if (c < ma75 * 0.95) return { direction: "down", count: 3 };

  return { direction: null, count: null };
}

/* ==========================================================================================
   In-In Harami（陰の陰はらみ）
========================================================================================== */

function isInInHarami(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 2) return false;

  const last = dates[dates.length - 1];
  const prev = dates[dates.length - 2];

  const c1 = daily[prev];
  const c2 = daily[last];

  if (!(c1.c < c1.o && c2.c < c2.o)) return false;

  const body1High = Math.max(c1.o, c1.c);
  const body1Low = Math.min(c1.o, c1.c);
  const body2High = Math.max(c2.o, c2.c);
  const body2Low = Math.min(c2.o, c2.c);

  const inside = body2High <= body1High && body2Low >= body1Low;

  const lookback = Math.min(10, dates.length);
  const lows = dates.slice(-lookback).map(d => daily[d].l);
  const recentMin = Math.min(...lows);
  const recentMax = Math.max(...lows);

  const downBias = recentMin < recentMax * 0.97;

  return inside && downBias;
}


/* ==========================================================================================
   戻り待ち売り後（Return Sell End）
========================================================================================== */

function isReturnSellEnd(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 60) return false;

  const closes = dates.map(d => daily[d].c);

  const recent = closes.slice(-40);
  if (recent[0] <= recent[recent.length - 1]) return false;

  let lowerLowCount = 0;
  let currentLow = recent[0];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] < currentLow) {
      lowerLowCount++;
      currentLow = recent[i];
    }
  }
  if (lowerLowCount < 3) return false;

  const last5 = dates.slice(-5);
  const last5Closes = last5.map(d => daily[d].c);
  let higherLow = true;
  let higherHigh = true;
  let minPrev = last5Closes[0];
  let maxPrev = last5Closes[0];
  for (let i = 1; i < last5Closes.length; i++) {
    if (last5Closes[i] <= minPrev) higherLow = false;
    if (last5Closes[i] <= maxPrev) higherHigh = false;
    minPrev = Math.min(minPrev, last5Closes[i]);
    maxPrev = Math.max(maxPrev, last5Closes[i]);
  }

  if (!(higherLow && higherHigh)) return false;

  const ma25 = safeCalcMA(daily, 25);
  if (ma25 === null) return false;
  const last = dates[dates.length - 1];
  const cLast = daily[last].c;

  return cLast > ma25;
}


/* ==========================================================================================
   下降相場の終わり（Down Trend End）
========================================================================================== */

function isDownTrendEnd(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 75) return false;

  const closes = dates.map(d => daily[d].c);
  const recent = closes.slice(-40);

  if (recent[0] <= recent[recent.length - 1]) return false;

  let lowerLowCount = 0;
  let currentLow = recent[0];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] < currentLow) {
      lowerLowCount++;
      currentLow = recent[i];
    }
  }
  if (lowerLowCount < 3) return false;

  const ma75 = safeCalcMA(daily, 75);
  if (ma75 === null) return false;
  const last = dates[dates.length - 1];
  const cLast = daily[last].c;

  const near = Math.abs(cLast - ma75) / ma75 <= 0.02;

  return near;
}


/* ==========================================================================================
   赤と青の交差（Red Blue Cross）
========================================================================================== */

function isRedBlueCross(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 25) return false;

  const last = dates[dates.length - 1];

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => (prevCandles[d] = daily[d]));

  const ma5_prev = safeCalcMA(prevCandles, 5);
  const ma20_prev = safeCalcMA(prevCandles, 20);
  const ma5_curr = safeCalcMA(daily, 5);
  const ma20_curr = safeCalcMA(daily, 20);

  if ([ma5_prev, ma20_prev, ma5_curr, ma20_curr].some(x => x === null)) return false;

  const crossed =
    (ma5_prev < ma20_prev && ma5_curr > ma20_curr) ||
    (ma5_prev > ma20_prev && ma5_curr < ma20_curr);

  if (!crossed) return false;

  const prev2Candles = {};
  dates.slice(0, -2).forEach(d => (prev2Candles[d] = daily[d]));
  const ma5_prev2 = safeCalcMA(prev2Candles, 5);
  const ma20_prev2 = safeCalcMA(prev2Candles, 20);
  if (ma5_prev2 === null || ma20_prev2 === null) return false;

  const slope5 = ma5_curr - ma5_prev2;
  const slope20 = ma20_curr - ma20_prev2;

  if (slope5 === 0 || slope20 === 0) return false;
  if (slope5 * slope20 <= 0) return false;

  return true;
}


/* ==========================================================================================
   揉み合い（Momiai）
========================================================================================== */

function isMomiai(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 100) return false;

  const ma60 = safeCalcMA(daily, 60);
  const ma100 = safeCalcMA(daily, 100);
  if (ma60 === null || ma100 === null) return false;

  const lower = Math.min(ma60, ma100);
  const upper = Math.max(ma60, ma100);

  const recent = dates.slice(-20);

  for (const d of recent) {
    const c = daily[d].c;

    const slice = {};
    dates.slice(0, dates.indexOf(d) + 1).forEach(x => (slice[x] = daily[x]));
    const ma5 = safeCalcMA(slice, 5);
    const ma20 = safeCalcMA(slice, 20);

    if (ma5 === null || ma20 === null) return false;

    if (!(c >= lower && c <= upper)) return false;
    if (!(ma5 >= lower && ma5 <= upper)) return false;
    if (!(ma20 >= lower && ma20 <= upper)) return false;
  }

  const closes = recent.map(d => daily[d].c);
  const maxC = Math.max(...closes);
  const minC = Math.min(...closes);
  if ((maxC - minC) / ((maxC + minC) / 2) >= 0.05) return false;

  return true;
}


/* ==========================================================================================
   値動きのサイクル（Cycle Progress）— window=150
========================================================================================== */

/**
 * TECH_CYCLE_PROGRESS — 値動きのサイクル進捗
 *
 * 返却値の意味：
 *   - daysFromLastSwing:
 *       直近150本の中で見つかった「大きな高値 or 大きな安値（スイング）」から
 *       現在まで何営業日経過したか。
 *
 *   - window:
 *       サイクル判定に使用したローソク足本数（150固定）。
 *       約7ヶ月に相当し、赤本の「サイクルは3〜6ヶ月」を踏まえ、
 *       余裕を持たせた判定期間。
 *
 *   - startDate:
 *       サイクルの起点となったスイング（高値 or 安値）の発生日。
 *
 *   - lastDate:
 *       最新ローソク足の日付。
 *
 * 例：
 *   {
 *     daysFromLastSwing: 42,
 *     window: 150,
 *     startDate: "20260115",
 *     lastDate: "20260510"
 *   }
 *
 *   → 直近150本の中で 2026/01/15 に大きな安値をつけ、
 *     そこから42営業日経過している（サイクルの前半〜中盤）。
 */

function computeCycleProgress(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 60) return null;

  const closes = dates.map(d => daily[d].c);

  const recent = closes.slice(-150);
  const baseIdx = dates.length - recent.length;

  let maxIdx = 0;
  let minIdx = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[maxIdx]) maxIdx = i;
    if (recent[i] < recent[minIdx]) minIdx = i;
  }

  const distFromMax = recent.length - 1 - maxIdx;
  const distFromMin = recent.length - 1 - minIdx;

  const startIdx = distFromMax < distFromMin ? maxIdx : minIdx;
  const progress = recent.length - 1 - startIdx;

  return {
    daysFromLastSwing: progress,
    window: 150,
    startDate: dates[baseIdx + startIdx],
    lastDate: dates[dates.length - 1]
  };
}


/* ==========================================================================================
   節目（Fushime Up / Down）
========================================================================================== */

function findFushimeLevel(daily, mode = "up") {
  const dates = Object.keys(daily).sort();
  if (dates.length < 60) return { price: null, tryCount: null };

  const recent = dates.slice(-60);
  const highs = recent.map(d => daily[d].h);
  const lows = recent.map(d => daily[d].l);

  const prices = mode === "up" ? highs : lows;
  const target = mode === "up" ? Math.max(...prices) : Math.min(...prices);

  const tol = target * 0.01;

  let tries = 0;
  for (let i = 0; i < prices.length; i++) {
    if (Math.abs(prices[i] - target) <= tol) tries++;
  }

  if (tries < 2) return { price: null, tryCount: null };

  return { price: target, tryCount: tries };
}

function computeFushimeUp(daily) {
  return findFushimeLevel(daily, "up");
}

function computeFushimeDown(daily) {
  return findFushimeLevel(daily, "down");
}


/* ==========================================================================================
   CommonJS エクスポート
========================================================================================== */

module.exports = {
  calcMA,
  safeCalcMA,
  safeLast,
  safeGetPrevCandles,

  isMaSlopeUpDaily,
  isMaSlopeDownDaily,
  isMaSlopeUpWeekly,
  isMaSlopeDownWeekly,
  isMaSlopeUpMonthly,
  isMaSlopeDownMonthly,

  isMaPositionDaily,
  isMaPositionWeekly,
  isMaPositionMonthly,

  isPerfectOrderDaily,
  isPerfectOrderWeekly,
  isPerfectOrderMonthly,

  isReversePerfectOrderDaily,
  isReversePerfectOrderWeekly,
  isReversePerfectOrderMonthly,

  isPrePerfectOrderDaily,
  isPrePerfectOrderWeekly,
  isPrePerfectOrderMonthly,

  isPreReversePerfectOrderDaily,
  isPreReversePerfectOrderWeekly,
  isPreReversePerfectOrderMonthly,

  isMaCongestion,
  isMaSpreadUp,
  isMa100Trend,

  isKahanshin,
  isGyakuKahanshin,

  is5MaHighUpdate,
  is5MaLowUpdate,

  isSakataTripleTop,
  isSakataTripleBottom,
  isSakataSankuUp,
  isSakataSankuDown,
  isSakataSanpeiUp,
  isSakataSanpeiDown,
  isSakataSanpoUp,
  isSakataSanpoDown,

  isHeadAndShoulders,
  isDoubleBottom,
  isNichiDai,
  isGyakuNichiDai,

  isMonowakareUp,
  isMonowakareDown,
  isMonowakareRedBlueCrossUp,
  isMonowakareRedBlueCrossDown,

  computeRule9Daily,
  computeRule9Weekly,

  isBbZoneBreakDaily,
  isBbZoneBreakWeekly,
  isBbZoneBreakMonthly,

  isBoxRange,
  isOverheat,

  computeGranville,

  isInInHarami,
  isReturnSellEnd,
  isDownTrendEnd,
  isRedBlueCross,
  isMomiai,

  computeCycleProgress,

  computeFushimeUp,
  computeFushimeDown
};
