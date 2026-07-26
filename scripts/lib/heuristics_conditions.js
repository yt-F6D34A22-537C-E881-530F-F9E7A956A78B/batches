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
   パーフェクトオーダー前夜 / 逆パーフェクトオーダー前夜
   仕様：「MAが右肩上がり（下がり）になっており、短期線以外は中期線>長期線（逆）になっている」
========================================================================================== */

function isPrePerfectOrderDaily(daily) {
  const ma5 = safeCalcMA(daily, 5);
  const ma25 = safeCalcMA(daily, 25);
  const ma75 = safeCalcMA(daily, 75);
  if (ma5 === null || ma25 === null || ma75 === null) return false;

  // 中期線>長期線（成立）かつ 短期線>中期線（未成立）
  const orderCond = ma25 > ma75 && !(ma5 > ma25);
  // 全MAが右肩上がり
  const slopeUp = isMaSlopeUp(daily, 5) && isMaSlopeUp(daily, 25) && isMaSlopeUp(daily, 75);

  return orderCond && slopeUp;
}

function isPreReversePerfectOrderDaily(daily) {
  const ma5 = safeCalcMA(daily, 5);
  const ma25 = safeCalcMA(daily, 25);
  const ma75 = safeCalcMA(daily, 75);
  if (ma5 === null || ma25 === null || ma75 === null) return false;

  // 長期線>中期線（成立）かつ 中期線>短期線（未成立）
  const orderCond = ma75 > ma25 && !(ma25 > ma5);
  // 全MAが右肩下がり
  const slopeDown = isMaSlopeDown(daily, 5) && isMaSlopeDown(daily, 25) && isMaSlopeDown(daily, 75);

  return orderCond && slopeDown;
}

function isPrePerfectOrderWeekly(weekly) {
  const ma5 = safeCalcMA(weekly, 5);
  const ma13 = safeCalcMA(weekly, 13);
  const ma26 = safeCalcMA(weekly, 26);
  if (ma5 === null || ma13 === null || ma26 === null) return false;

  const orderCond = ma13 > ma26 && !(ma5 > ma13);
  const slopeUp = isMaSlopeUp(weekly, 5) && isMaSlopeUp(weekly, 13) && isMaSlopeUp(weekly, 26);

  return orderCond && slopeUp;
}

function isPreReversePerfectOrderWeekly(weekly) {
  const ma5 = safeCalcMA(weekly, 5);
  const ma13 = safeCalcMA(weekly, 13);
  const ma26 = safeCalcMA(weekly, 26);
  if (ma5 === null || ma13 === null || ma26 === null) return false;

  const orderCond = ma26 > ma13 && !(ma13 > ma5);
  const slopeDown = isMaSlopeDown(weekly, 5) && isMaSlopeDown(weekly, 13) && isMaSlopeDown(weekly, 26);

  return orderCond && slopeDown;
}

function isPrePerfectOrderMonthly(monthly) {
  const ma5 = safeCalcMA(monthly, 5);
  const ma12 = safeCalcMA(monthly, 12);
  const ma24 = safeCalcMA(monthly, 24);
  if (ma5 === null || ma12 === null || ma24 === null) return false;

  const orderCond = ma12 > ma24 && !(ma5 > ma12);
  const slopeUp = isMaSlopeUp(monthly, 5) && isMaSlopeUp(monthly, 12) && isMaSlopeUp(monthly, 24);

  return orderCond && slopeUp;
}

function isPreReversePerfectOrderMonthly(monthly) {
  const ma5 = safeCalcMA(monthly, 5);
  const ma12 = safeCalcMA(monthly, 12);
  const ma24 = safeCalcMA(monthly, 24);
  if (ma5 === null || ma12 === null || ma24 === null) return false;

  const orderCond = ma24 > ma12 && !(ma12 > ma5);
  const slopeDown = isMaSlopeDown(monthly, 5) && isMaSlopeDown(monthly, 12) && isMaSlopeDown(monthly, 24);

  return orderCond && slopeDown;
}


/* ==========================================================================================
   移動平均線の収束（5/10/20）
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
   移動平均線の拡散
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
   100MAトレンド
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
   仕様：「右肩上がりの5日線を陽線でまたいで上抜け。窓開け（始値が5MA超）も対象。」
        「注意：下向きの5日線をローソク足が陽線で抜けても下半身ではない」
========================================================================================== */

function isKahanshin(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 6) return false;

  const today = dates[dates.length - 1];
  const prev  = dates[dates.length - 2];

  const o     = daily[today].o;
  const c     = daily[today].c;
  const cPrev = daily[prev].c;

  const ma5_today = safeCalcMA(daily, 5);
  if (ma5_today === null) return false;

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => (prevCandles[d] = daily[d]));
  const ma5_prev = safeCalcMA(prevCandles, 5);
  if (ma5_prev === null) return false;

  // 5MAが右肩上がり、前日終値が5MA以下、当日陽線
  if (!(ma5_today > ma5_prev && o < c && cPrev < ma5_prev)) return false;

  // 通常：ローソク足が5MAをまたいで上抜け
  const normalCase = o < ma5_today && c > ma5_today;
  // 窓開け：始値が既に5MA超（窓を開けて飛び越え）
  const gapCase    = o > ma5_today && c > ma5_today;

  return normalCase || gapCase;
}

function isGyakuKahanshin(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 6) return false;

  const today = dates[dates.length - 1];
  const prev  = dates[dates.length - 2];

  const o     = daily[today].o;
  const c     = daily[today].c;
  const cPrev = daily[prev].c;

  const ma5_today = safeCalcMA(daily, 5);
  if (ma5_today === null) return false;

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => (prevCandles[d] = daily[d]));
  const ma5_prev = safeCalcMA(prevCandles, 5);
  if (ma5_prev === null) return false;

  // 5MAが右肩下がり、前日終値が5MA以上、当日陰線
  if (!(ma5_today < ma5_prev && o > c && cPrev > ma5_prev)) return false;

  // 通常：ローソク足が5MAをまたいで下抜け
  const normalCase = o > ma5_today && c < ma5_today;
  // 窓開け：始値が既に5MA未満（窓を開けて飛び越え）
  const gapCase    = o < ma5_today && c < ma5_today;

  return normalCase || gapCase;
}


/* ==========================================================================================
   5MA更新
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
   パターン
========================================================================================== */

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
   仕様：「5日線やローソク足の終値線が大底圏で2度の安値を付けたあと上昇」
========================================================================================== */

function isDoubleBottom(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 10) return false;

  // 直近10本で判定
  const recent = dates.slice(-10);

  const closes = recent.map(d => daily[d].c);
  const lows   = recent.map(d => daily[d].l);

  // 最安値を2つ探す（W字の2つの底）
  let firstLowIdx = -1;
  let secondLowIdx = -1;
  let firstLow = Infinity;

  // 前半5本の最安値を1つ目の底とする
  for (let i = 0; i < 5; i++) {
    if (lows[i] < firstLow) {
      firstLow = lows[i];
      firstLowIdx = i;
    }
  }

  let secondLow = Infinity;
  // 後半5本の最安値を2つ目の底とする
  for (let i = 5; i < 10; i++) {
    if (lows[i] < secondLow) {
      secondLow = lows[i];
      secondLowIdx = i;
    }
  }

  if (firstLowIdx === -1 || secondLowIdx === -1) return false;

  // 2つの底が近い水準（3%以内）
  const tolerance = firstLow * 0.03;
  const cond1 = Math.abs(firstLow - secondLow) < tolerance;

  // 2つ目の底が1つ目より深くない（切り上がりか同水準）
  const cond2 = secondLow >= firstLow * 0.97;

  // 2つ目の底の後（直近）に株価が上昇している（終値が2つ目の底を上抜け）
  const lastClose = closes[closes.length - 1];
  const cond3 = lastClose > secondLow * 1.01;

  // 5日線が上向き（上昇転換の確認）
  const slopeUp = isMaSlopeUp(daily, 5);

  return cond1 && cond2 && cond3 && slopeUp;
}


/* ==========================================================================================
   N大 / 逆N大
   仕様：「中期線を上抜いた5日線が下落し、中期線に近づいたあと再度上昇加速。
          中期線と5日線の傾きが上昇方向である必要がある。」
========================================================================================== */

function isNichiDai(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 30) return false;

  const ma5_today  = safeCalcMA(daily, 5);
  const ma25_today = safeCalcMA(daily, 25);
  if (ma5_today === null || ma25_today === null) return false;

  // 5MAと25MAが右肩上がり
  if (!isMaSlopeUp(daily, 5) || !isMaSlopeUp(daily, 25)) return false;

  // 現在：5MAが25MAより上
  if (ma5_today <= ma25_today) return false;

  // 過去10本の5MAと25MAの差を計算
  // 途中で差が縮小（25MAの2%以内まで接近）し、現在は拡大している
  const recentDates = dates.slice(-10);
  const spreadList = recentDates.map(d => {
    const sub = {};
    dates.slice(0, dates.indexOf(d) + 1).forEach(x => (sub[x] = daily[x]));
    const m5  = safeCalcMA(sub, 5);
    const m25 = safeCalcMA(sub, 25);
    if (m5 === null || m25 === null) return null;
    return m5 - m25;
  }).filter(v => v !== null);

  if (spreadList.length < 3) return false;

  // 直近を除いた中での最小差（5MAが25MAに最も近づいた時点）
  const minSpread     = Math.min(...spreadList.slice(0, -1));
  const currentSpread = spreadList[spreadList.length - 1];

  // 25MAの2%以内まで近づいた後、現在は離れている
  return minSpread < ma25_today * 0.02 && currentSpread > minSpread;
}

function isGyakuNichiDai(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 30) return false;

  const ma5_today  = safeCalcMA(daily, 5);
  const ma25_today = safeCalcMA(daily, 25);
  if (ma5_today === null || ma25_today === null) return false;

  // 5MAと25MAが右肩下がり
  if (!isMaSlopeDown(daily, 5) || !isMaSlopeDown(daily, 25)) return false;

  // 現在：5MAが25MAより下
  if (ma5_today >= ma25_today) return false;

  const recentDates = dates.slice(-10);
  const spreadList = recentDates.map(d => {
    const sub = {};
    dates.slice(0, dates.indexOf(d) + 1).forEach(x => (sub[x] = daily[x]));
    const m5  = safeCalcMA(sub, 5);
    const m25 = safeCalcMA(sub, 25);
    if (m5 === null || m25 === null) return null;
    return m25 - m5; // 下降時は 25MA - 5MA（正の値）
  }).filter(v => v !== null);

  if (spreadList.length < 3) return false;

  const minSpread     = Math.min(...spreadList.slice(0, -1));
  const currentSpread = spreadList[spreadList.length - 1];

  return minSpread < ma25_today * 0.02 && currentSpread > minSpread;
}

/* ==========================================================================================
   陰の陰はらみ
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
   戻り待ち売り後
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
   下降相場の終わり
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
   赤と青の交差
   仕様：「5MA × 20MA が交差。赤と青の傾きが同じ方向。週足・月足も同方向。」
   引数：週足・月足データを追加（heuristics.js 側の呼び出しも変更が必要）
========================================================================================== */

function isRedBlueCross(daily, weekly, monthly) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 25) return false;

  const last = dates[dates.length - 1];

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => (prevCandles[d] = daily[d]));

  const ma5_prev  = safeCalcMA(prevCandles, 5);
  const ma20_prev = safeCalcMA(prevCandles, 20);
  const ma5_curr  = safeCalcMA(daily, 5);
  const ma20_curr = safeCalcMA(daily, 20);

  if ([ma5_prev, ma20_prev, ma5_curr, ma20_curr].some(x => x === null)) return false;

  // 5MAと20MAが交差している
  const crossed =
    (ma5_prev < ma20_prev && ma5_curr > ma20_curr) ||
    (ma5_prev > ma20_prev && ma5_curr < ma20_curr);

  if (!crossed) return false;

  // 赤（5MA）と青（20MA）の傾きが同じ方向
  const prev2Candles = {};
  dates.slice(0, -2).forEach(d => (prev2Candles[d] = daily[d]));
  const ma5_prev2  = safeCalcMA(prev2Candles, 5);
  const ma20_prev2 = safeCalcMA(prev2Candles, 20);
  if (ma5_prev2 === null || ma20_prev2 === null) return false;

  const slope5  = ma5_curr  - ma5_prev2;
  const slope20 = ma20_curr - ma20_prev2;

  // 両MAの傾きが同方向
  if (slope5 === 0 || slope20 === 0) return false;
  if (slope5 * slope20 <= 0) return false;

  // 週足：5週線と20週線の傾きが同方向
  if (weekly) {
    const wDates = Object.keys(weekly).sort();
    if (wDates.length >= 22) {
      const wPrev = {};
      wDates.slice(0, -2).forEach(d => (wPrev[d] = weekly[d]));
      const wma5_curr  = safeCalcMA(weekly, 5);
      const wma20_curr = safeCalcMA(weekly, 20);
      const wma5_prev  = safeCalcMA(wPrev, 5);
      const wma20_prev = safeCalcMA(wPrev, 20);

      if (wma5_curr !== null && wma20_curr !== null && wma5_prev !== null && wma20_prev !== null) {
        const wSlope5  = wma5_curr  - wma5_prev;
        const wSlope20 = wma20_curr - wma20_prev;
        if (wSlope5 !== 0 && wSlope20 !== 0 && wSlope5 * wSlope20 <= 0) return false;
        // 週足の傾き方向と日足が逆なら除外
        if (wSlope5 * slope5 < 0) return false;
      }
    }
  }

  // 月足：5月線と20月線の傾きが同方向
  if (monthly) {
    const mDates = Object.keys(monthly).sort();
    if (mDates.length >= 22) {
      const mPrev = {};
      mDates.slice(0, -2).forEach(d => (mPrev[d] = monthly[d]));
      const mma5_curr  = safeCalcMA(monthly, 5);
      const mma20_curr = safeCalcMA(monthly, 20);
      const mma5_prev  = safeCalcMA(mPrev, 5);
      const mma20_prev = safeCalcMA(mPrev, 20);

      if (mma5_curr !== null && mma20_curr !== null && mma5_prev !== null && mma20_prev !== null) {
        const mSlope5  = mma5_curr  - mma5_prev;
        const mSlope20 = mma20_curr - mma20_prev;
        if (mSlope5 !== 0 && mSlope20 !== 0 && mSlope5 * mSlope20 <= 0) return false;
        // 月足の傾き方向と日足が逆なら除外
        if (mSlope5 * slope5 < 0) return false;
      }
    }
  }

  return true;
}


/* ==========================================================================================
   揉み合い
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
   ものわかれ
   仕様：「5日線が10日線、10日線が20日線にいったん近づいて離れる」
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
   ものわかれ（赤と青の交差：5MA × 20MA）
   仕様：「赤(5日線)、青(20日線)が対象。いったん近づいて離れる形成。
          赤と青の傾きが同じ方向。週足・月足も同方向。」
========================================================================================== */

function isMonowakareRedBlueCrossUp(daily, weekly, monthly) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 21) return false;

  const ma5_today  = safeCalcMA(daily, 5);
  const ma20_today = safeCalcMA(daily, 20);

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => (prevCandles[d] = daily[d]));

  const ma5_prev  = safeCalcMA(prevCandles, 5);
  const ma20_prev = safeCalcMA(prevCandles, 20);

  if ([ma5_today, ma20_today, ma5_prev, ma20_prev].some(x => x === null)) return false;

  // 上昇：5MAが20MAを下から上にクロス（ものわかれの形成）
  const cond1 = ma5_prev < ma20_prev && ma5_today > ma20_today;

  // 赤（5MA）と青（20MA）の傾きが同じ上昇方向
  const slope5  = ma5_today  - ma5_prev;
  const slope20 = ma20_today - ma20_prev;
  const cond2 = slope5 > 0 && slope20 > 0;

  if (!(cond1 && cond2)) return false;

  // 週足：5週線と20週線が同じ上昇方向
  if (weekly) {
    const wDates = Object.keys(weekly).sort();
    if (wDates.length >= 22) {
      const wPrev = {};
      wDates.slice(0, -1).forEach(d => (wPrev[d] = weekly[d]));
      const wma5_curr  = safeCalcMA(weekly, 5);
      const wma20_curr = safeCalcMA(weekly, 20);
      const wma5_prev  = safeCalcMA(wPrev, 5);
      const wma20_prev = safeCalcMA(wPrev, 20);
      if (wma5_curr !== null && wma20_curr !== null && wma5_prev !== null && wma20_prev !== null) {
        if (!(wma5_curr - wma5_prev > 0 && wma20_curr - wma20_prev > 0)) return false;
      }
    }
  }

  // 月足：5月線と20月線が同じ上昇方向
  if (monthly) {
    const mDates = Object.keys(monthly).sort();
    if (mDates.length >= 22) {
      const mPrev = {};
      mDates.slice(0, -1).forEach(d => (mPrev[d] = monthly[d]));
      const mma5_curr  = safeCalcMA(monthly, 5);
      const mma20_curr = safeCalcMA(monthly, 20);
      const mma5_prev  = safeCalcMA(mPrev, 5);
      const mma20_prev = safeCalcMA(mPrev, 20);
      if (mma5_curr !== null && mma20_curr !== null && mma5_prev !== null && mma20_prev !== null) {
        if (!(mma5_curr - mma5_prev > 0 && mma20_curr - mma20_prev > 0)) return false;
      }
    }
  }

  return true;
}

function isMonowakareRedBlueCrossDown(daily, weekly, monthly) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 21) return false;

  const ma5_today  = safeCalcMA(daily, 5);
  const ma20_today = safeCalcMA(daily, 20);

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => (prevCandles[d] = daily[d]));

  const ma5_prev  = safeCalcMA(prevCandles, 5);
  const ma20_prev = safeCalcMA(prevCandles, 20);

  if ([ma5_today, ma20_today, ma5_prev, ma20_prev].some(x => x === null)) return false;

  // 下降：5MAが20MAを上から下にクロス（ものわかれの形成）
  const cond1 = ma5_prev > ma20_prev && ma5_today < ma20_today;

  // 赤（5MA）と青（20MA）の傾きが同じ下降方向
  const slope5  = ma5_today  - ma5_prev;
  const slope20 = ma20_today - ma20_prev;
  const cond2 = slope5 < 0 && slope20 < 0;

  if (!(cond1 && cond2)) return false;

  // 週足：5週線と20週線が同じ下降方向
  if (weekly) {
    const wDates = Object.keys(weekly).sort();
    if (wDates.length >= 22) {
      const wPrev = {};
      wDates.slice(0, -1).forEach(d => (wPrev[d] = weekly[d]));
      const wma5_curr  = safeCalcMA(weekly, 5);
      const wma20_curr = safeCalcMA(weekly, 20);
      const wma5_prev  = safeCalcMA(wPrev, 5);
      const wma20_prev = safeCalcMA(wPrev, 20);
      if (wma5_curr !== null && wma20_curr !== null && wma5_prev !== null && wma20_prev !== null) {
        if (!(wma5_curr - wma5_prev < 0 && wma20_curr - wma20_prev < 0)) return false;
      }
    }
  }

  // 月足：5月線と20月線が同じ下降方向
  if (monthly) {
    const mDates = Object.keys(monthly).sort();
    if (mDates.length >= 22) {
      const mPrev = {};
      mDates.slice(0, -1).forEach(d => (mPrev[d] = monthly[d]));
      const mma5_curr  = safeCalcMA(monthly, 5);
      const mma20_curr = safeCalcMA(monthly, 20);
      const mma5_prev  = safeCalcMA(mPrev, 5);
      const mma20_prev = safeCalcMA(mPrev, 20);
      if (mma5_curr !== null && mma20_curr !== null && mma5_prev !== null && mma20_prev !== null) {
        if (!(mma5_curr - mma5_prev < 0 && mma20_curr - mma20_prev < 0)) return false;
      }
    }
  }

  return true;
}

/* ==========================================================================================
   9の法則
========================================================================================== */

function computeRule9Daily(daily) {
  const dates = Object.keys(daily).sort();
  const n = dates.length;
  if (n < 3) return { direction: null, count: 0 };

  const closes = dates.map(d => daily[d].c);

  // MA5 / MA100 をローリング合計で逐次計算する（O(n)）。
  // 2026-07 修正: 旧実装はi件ごとに部分オブジェクトを毎回コピー構築してcalcMA()を
  // 呼んでいたためO(n^2 log n)だった。日足の取得期間を1年→10年相当に拡大した際、
  // n（日足件数）が約250→約2,500に増え、1銘柄あたりの計算時間が理論値で約140倍に
  // 悪化し、heuristics.js のrangeモードが実質的に停止する不具合の原因となった。
  // 計算結果（各時点のMA5/MA100の値）は旧実装と完全に同一で、計算量のみ改善している。
  const ma5 = new Array(n).fill(null);
  const ma100 = new Array(n).fill(null);
  let sum5 = 0, sum100 = 0;
  for (let i = 0; i < n; i++) {
    sum5 += closes[i];
    if (i >= 5) sum5 -= closes[i - 5];
    if (i >= 4) ma5[i] = sum5 / 5;

    sum100 += closes[i];
    if (i >= 100) sum100 -= closes[i - 100];
    if (i >= 99) ma100[i] = sum100 / 100;
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

    const prevMA5 = ma5[i - 1];
    const prevMA100 = ma100[i - 1];
    const todayMA5 = ma5[i];
    const todayMA100 = ma100[i];

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

  const closes = dates.map(d => weekly[d].c);

  // MA5 / MA100 をローリング合計で逐次計算する（O(n)。2026-07修正、詳細は computeRule9Daily を参照）
  const ma5 = new Array(n).fill(null);
  const ma100 = new Array(n).fill(null);
  let sum5 = 0, sum100 = 0;
  for (let i = 0; i < n; i++) {
    sum5 += closes[i];
    if (i >= 5) sum5 -= closes[i - 5];
    if (i >= 4) ma5[i] = sum5 / 5;

    sum100 += closes[i];
    if (i >= 100) sum100 -= closes[i - 100];
    if (i >= 99) ma100[i] = sum100 / 100;
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

    const prevMA5 = ma5[i - 1];
    const prevMA100 = ma100[i - 1];
    const todayMA5 = ma5[i];
    const todayMA100 = ma100[i];

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
   BBゾーンブレイク（0σ / 1σ / 2σ / 3σ）
   仕様：「ゾーンを終値で下へ割った場合が調整入りの目安。例）2σ → 1σ」
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
   ボックスレンジ（横ばい）
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
   過熱 — TODO（仕様未確定）
========================================================================================== */

function isOverheat(daily) {
  // TODO: 2026-06-19 泰長より仕様未確定。
  // RSI / 乖離率 / BB / MA など複数候補があるため、
  // 現時点では骨組みのみ実装し、常に false を返す。
  return false;
}


/* ==========================================================================================
   グランビル
   仕様（上昇相場）：
     1回目：75日線がフラットか少し上向きのときに株価が75日線を上抜け
     2回目：株価が上向きの75日線の下から上に抜ける（再上昇）
     3回目：株価が75日線より大幅に上（加熱・高値掴みの局面）
     4回目：75日線を割るか、割る前に一時上昇（上昇相場の終わり）
   仕様（下降相場）：
     1回目：高値に再挑戦して失敗（75日線まだ下向いていない）
     2回目：75日線が下向きになり始め、株価が75日線を下抜け
     3回目：暴落・投げ相場（株価が75日線の5%以上下）
========================================================================================== */

function computeGranville(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 80) return { direction: null, count: null };

  const last = dates[dates.length - 1];
  const prev = dates[dates.length - 2];

  const c  = daily[last].c;
  const cp = daily[prev].c;

  const ma75 = safeCalcMA(daily, 75);
  if (ma75 === null) return { direction: null, count: null };

  const prevSlice = {};
  dates.slice(0, -1).forEach(d => (prevSlice[d] = daily[d]));
  const ma75_prev = safeCalcMA(prevSlice, 75);
  if (ma75_prev === null) return { direction: null, count: null };

  const prev2Slice = {};
  dates.slice(0, -2).forEach(d => (prev2Slice[d] = daily[d]));
  const ma75_prev2 = safeCalcMA(prev2Slice, 75);

  // -------------------------------------------------------
  // 上昇相場の判定（優先順：4回目→1回目→2回目→3回目）
  // -------------------------------------------------------

  // 上昇4回目：75日線を割り込んだ（最後のチャンス）
  if (cp > ma75_prev && c < ma75) return { direction: "up", count: 4 };

  // 上昇1回目：75日線がフラットか上向き、株価が75日線を下から上に抜けた
  if (ma75 >= ma75_prev && cp <= ma75_prev && c > ma75) {
    return { direction: "up", count: 1 };
  }

  // 上昇2回目：75日線が上向き、株価が75日線の下から上に再び抜けた
  if (ma75 > ma75_prev && cp < ma75 && c > ma75) {
    return { direction: "up", count: 2 };
  }

  // 上昇3回目：75日線より5%以上乖離（加熱）
  if (c > ma75 * 1.05) return { direction: "up", count: 3 };

  // -------------------------------------------------------
  // 下降相場の判定
  // -------------------------------------------------------

  // 下降1回目：75日線はまだ下向いていない（フラットか上向き）が、
  //            株価が75日線付近で失速（高値から下落し75日線を下抜け）
  if (ma75 >= ma75_prev && cp > ma75 && c < ma75) {
    return { direction: "down", count: 1 };
  }

  // 下降2回目：75日線が下向きになり始め、株価が75日線を下抜け
  if (ma75 < ma75_prev && cp > ma75 && c < ma75) {
    return { direction: "down", count: 2 };
  }

  // 下降3回目：75日線より5%以上下（暴落・投げ相場）
  if (c < ma75 * 0.95) return { direction: "down", count: 3 };

  return { direction: null, count: null };
}


/* ==========================================================================================
   値動きのサイクル（Cycle Progress）— window=150
   仕様：「direction（上昇/下降サイクルの方向）と count（起点からの経過日数）を返す」
         直近スイングが安値→上昇サイクル、高値→下降サイクル。
========================================================================================== */

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

  // 直近のスイングが安値→上昇サイクル、高値→下降サイクル
  const isUpCycle = distFromMin < distFromMax;
  const startIdx  = isUpCycle ? minIdx : maxIdx;
  const direction = isUpCycle ? "up" : "down";
  const count     = recent.length - 1 - startIdx;

  return {
    direction,
    count,
    startDate: dates[baseIdx + startIdx],
    lastDate: dates[dates.length - 1]
  };
}


/* ==========================================================================================
   節目
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
   エクスポート
========================================================================================== */

export {
  calcMA,
  safeCalcMA,
  safeLast,
  safeGetPrevCandles,

  /* 移動平均線の傾き */
  isMaSlopeUpDaily,
  isMaSlopeDownDaily,
  isMaSlopeUpWeekly,
  isMaSlopeDownWeekly,
  isMaSlopeUpMonthly,
  isMaSlopeDownMonthly,

  /* 移動平均線の位置 */
  isMaPositionDaily,
  isMaPositionWeekly,
  isMaPositionMonthly,

  /* パーフェクトオーダー */
  isPerfectOrderDaily,
  isPerfectOrderWeekly,
  isPerfectOrderMonthly,

  /* 逆パーフェクトオーダー */
  isReversePerfectOrderDaily,
  isReversePerfectOrderWeekly,
  isReversePerfectOrderMonthly,

  /* パーフェクトオーダー前夜 */
  isPrePerfectOrderDaily,
  isPrePerfectOrderWeekly,
  isPrePerfectOrderMonthly,

  /* 逆パーフェクトオーダー前夜 */
  isPreReversePerfectOrderDaily,
  isPreReversePerfectOrderWeekly,
  isPreReversePerfectOrderMonthly,

  /* 移動平均線の収束 */
  isMaCongestion,

  /* 移動平均線の拡散 */
  isMaSpreadUp,

  /* 100MAトレンド */
  isMa100Trend,

  /* 下半身・逆下半身 */
  isKahanshin,
  isGyakuKahanshin,

  /* 5MA更新 */
  is5MaHighUpdate,
  is5MaLowUpdate,

  /* 酒田五法 */
  isSakataTripleTop,
  isSakataTripleBottom,
  isSakataSankuUp,
  isSakataSankuDown,
  isSakataSanpeiUp,
  isSakataSanpeiDown,
  isSakataSanpoUp,
  isSakataSanpoDown,

  /* パターン */
  isHeadAndShoulders,
  isDoubleBottom,
  isNichiDai,
  isGyakuNichiDai,
  isInInHarami,
  isRedBlueCross,
  isReturnSellEnd,
  isDownTrendEnd,
  isMomiai,

  /* 物別れ */
  isMonowakareUp,
  isMonowakareDown,
  isMonowakareRedBlueCrossUp,
  isMonowakareRedBlueCrossDown,

  /* 9の法則 */
  computeRule9Daily,
  computeRule9Weekly,

  /* BBゾーンブレイク */
  isBbZoneBreakDaily,
  isBbZoneBreakWeekly,
  isBbZoneBreakMonthly,

  /* ボックスレンジ */
  isBoxRange,

  /* 過熱 */
  isOverheat,

  /* グランビル */
  computeGranville,

  /* トレンドサイクル進行度 */
  computeCycleProgress,

  /* 節目 */
  computeFushimeUp,
  computeFushimeDown
};
