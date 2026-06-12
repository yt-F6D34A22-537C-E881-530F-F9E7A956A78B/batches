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

// =========================================================
// PRE-PO / PRE-RPO（前夜）
// =========================================================

function countReverseForPO(maS, maM, maL) {
  let reverse = 0;
  if (!(maS > maM)) reverse++;
  if (!(maM > maL)) reverse++;
  return reverse;
}

function countReverseForRPO(maS, maM, maL) {
  let reverse = 0;
  if (!(maS < maM)) reverse++;
  if (!(maM < maL)) reverse++;
  return reverse;
}

export function isPrePerfectOrder(daily) {
  const ma5  = calcMA(daily, 5);
  const ma25 = calcMA(daily, 25);
  const ma75 = calcMA(daily, 75);

  const reverse = countReverseForPO(ma5, ma25, ma75);

  // 1 箇所だけ逆転 → PRE-PO
  return reverse === 1;
}

export function isPreReversePerfectOrder(daily) {
  const ma5  = calcMA(daily, 5);
  const ma25 = calcMA(daily, 25);
  const ma75 = calcMA(daily, 75);

  const reverse = countReverseForRPO(ma5, ma25, ma75);

  // 1 箇所だけ逆転 → PRE-RPO
  return reverse === 1;
}

// =========================================================
// MA 密集（Congestion）
// =========================================================

export function isMaCongestionUp(daily) {
  const ma5  = calcMA(daily, 5);
  const ma25 = calcMA(daily, 25);
  const ma75 = calcMA(daily, 75);

  const arr = [ma5, ma25, ma75];
  const max = Math.max(...arr);
  const min = Math.min(...arr);

  // 密集判定（1.5%以内）
  const THRESHOLD = 0.015;
  const congestion = (max - min) / min < THRESHOLD;

  if (!congestion) return false;

  // 上向き判定（25MA の傾き）
  return isMaSlopeUp(daily, 25);
}

export function isMaCongestionDown(daily) {
  const ma5  = calcMA(daily, 5);
  const ma25 = calcMA(daily, 25);
  const ma75 = calcMA(daily, 75);

  const arr = [ma5, ma25, ma75];
  const max = Math.max(...arr);
  const min = Math.min(...arr);

  // 密集判定（1.5%以内）
  const THRESHOLD = 0.015;
  const congestion = (max - min) / min < THRESHOLD;

  if (!congestion) return false;

  // 下向き判定（25MA の傾き）
  return isMaSlopeDown(daily, 25);
}

// =========================================================
// MA 間隔（Spread）
// =========================================================

export function isMaSpreadUp(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 26) {
    throw new Error("Not enough candles for MA Spread check");
  }

  // 今日まで
  const todayCandles = {};
  dates.forEach(d => todayCandles[d] = daily[d]);

  // 昨日まで
  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);

  const ma5_today  = calcMA(todayCandles, 5);
  const ma25_today = calcMA(todayCandles, 25);

  const ma5_prev   = calcMA(prevCandles, 5);
  const ma25_prev  = calcMA(prevCandles, 25);

  const spread_today = Math.abs(ma5_today - ma25_today);
  const spread_prev  = Math.abs(ma5_prev - ma25_prev);

  return spread_today > spread_prev;
}

export function isMaSpreadDown(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 26) {
    throw new Error("Not enough candles for MA Spread check");
  }

  // 今日まで
  const todayCandles = {};
  dates.forEach(d => todayCandles[d] = daily[d]);

  // 昨日まで
  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);

  const ma5_today  = calcMA(todayCandles, 5);
  const ma25_today = calcMA(todayCandles, 25);

  const ma5_prev   = calcMA(prevCandles, 5);
  const ma25_prev  = calcMA(prevCandles, 25);

  const spread_today = Math.abs(ma5_today - ma25_today);
  const spread_prev  = Math.abs(ma5_prev - ma25_prev);

  return spread_today < spread_prev;
}

// =========================================================
// 100日線トレンド（上昇 / 下降）
// =========================================================

function getPrevCandles(candles, n) {
  const dates = Object.keys(candles).sort();
  if (dates.length < n) {
    throw new Error(`Not enough candles for getPrevCandles(${n})`);
  }
  const sliced = dates.slice(0, -n);
  const obj = {};
  sliced.forEach(d => obj[d] = candles[d]);
  return obj;
}

export function isMa100TrendUp(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 102) {
    throw new Error("Not enough candles for MA100 trend check");
  }

  // 今日・昨日・一昨日までのデータ
  const todayCandles = daily;
  const prevCandles = getPrevCandles(daily, 1);
  const prevPrevCandles = getPrevCandles(daily, 2);

  // MA100
  const ma100_today    = calcMA(todayCandles, 100);
  const ma100_prev     = calcMA(prevCandles, 100);
  const ma100_prevprev = calcMA(prevPrevCandles, 100);

  // 100日線の傾き変化（下降 → 上昇）
  const slopeChange =
    (ma100_prevprev > ma100_prev) &&   // 下降
    (ma100_prev < ma100_today);        // → 上昇

  if (!slopeChange) return false;

  // 終値 or MA25 が 100日線を上抜け
  const lastDate = dates[dates.length - 1];
  const close_today = daily[lastDate].c;

  const ma25_today = calcMA(todayCandles, 25);

  const cross =
    (close_today > ma100_today) ||
    (ma25_today > ma100_today);

  return cross;
}

export function isMa100TrendDown(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 102) {
    throw new Error("Not enough candles for MA100 trend check");
  }

  // 今日・昨日・一昨日までのデータ
  const todayCandles = daily;
  const prevCandles = getPrevCandles(daily, 1);
  const prevPrevCandles = getPrevCandles(daily, 2);

  // MA100
  const ma100_today    = calcMA(todayCandles, 100);
  const ma100_prev     = calcMA(prevCandles, 100);
  const ma100_prevprev = calcMA(prevPrevCandles, 100);

  // 100日線の傾き変化（上昇 → 下降）
  const slopeChange =
    (ma100_prevprev < ma100_prev) &&   // 上昇
    (ma100_prev > ma100_today);        // → 下降

  if (!slopeChange) return false;

  // 終値 or MA25 が 100日線を下抜け
  const lastDate = dates[dates.length - 1];
  const close_today = daily[lastDate].c;

  const ma25_today = calcMA(todayCandles, 25);

  const cross =
    (close_today < ma100_today) ||
    (ma25_today < ma100_today);

  return cross;
}

// =========================================================
// 下半身（Kahanshin） / 逆下半身（GyakuKahanshin）
// =========================================================

export function isKahanshin(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 6) {
    throw new Error("Not enough candles for Kahanshin");
  }

  const today = dates[dates.length - 1];
  const prev  = dates[dates.length - 2];

  const o_today = daily[today].o;
  const c_today = daily[today].c;
  const c_prev  = daily[prev].c;

  // MA5
  const ma5_today = calcMA(daily, 5);

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);
  const ma5_prev = calcMA(prevCandles, 5);

  // 1. 5MA が右肩上がり
  const cond1 = ma5_today > ma5_prev;

  // 2. 今日が陽線
  const cond2 = o_today < c_today;

  // 3. 終値が 5MA を上抜け（前日は下）
  const cond3 = (c_prev < ma5_prev) && (c_today > ma5_today);

  return cond1 && cond2 && cond3;
}

export function isGyakuKahanshin(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 6) {
    throw new Error("Not enough candles for GyakuKahanshin");
  }

  const today = dates[dates.length - 1];
  const prev  = dates[dates.length - 2];

  const o_today = daily[today].o;
  const c_today = daily[today].c;
  const c_prev  = daily[prev].c;

  // MA5
  const ma5_today = calcMA(daily, 5);

  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);
  const ma5_prev = calcMA(prevCandles, 5);

  // 1. 5MA が右肩下がり
  const cond1 = ma5_today < ma5_prev;

  // 2. 今日が陰線
  const cond2 = o_today > c_today;

  // 3. 終値が 5MA を下抜け（前日は上）
  const cond3 = (c_prev > ma5_prev) && (c_today < ma5_today);

  return cond1 && cond2 && cond3;
}

// =========================================================
// 5日線更新（高値更新 / 安値更新）
// =========================================================

export function is5MaHighUpdate(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 10) {
    throw new Error("Not enough candles for 5MA High Update");
  }

  // 今日の MA5
  const ma5_today = calcMA(daily, 5);

  // 過去5日分の MA5 を計算
  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);

  const prevDates = dates.slice(-6, -1); // 過去5日
  const ma5_prev_list = prevDates.map((_, idx) => {
    const tmp = {};
    dates.slice(0, dates.length - (5 - idx)).forEach(d => tmp[d] = daily[d]);
    return calcMA(tmp, 5);
  });

  const maxPrev = Math.max(...ma5_prev_list);

  return ma5_today > maxPrev;
}

export function is5MaLowUpdate(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 10) {
    throw new Error("Not enough candles for 5MA Low Update");
  }

  // 今日の MA5
  const ma5_today = calcMA(daily, 5);

  // 過去5日分の MA5 を計算
  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);

  const prevDates = dates.slice(-6, -1); // 過去5日
  const ma5_prev_list = prevDates.map((_, idx) => {
    const tmp = {};
    dates.slice(0, dates.length - (5 - idx)).forEach(d => tmp[d] = daily[d]);
    return calcMA(tmp, 5);
  });

  const minPrev = Math.min(...ma5_prev_list);

  return ma5_today < minPrev;
}

// =========================================================
// 酒田五法（Sakata Patterns）
// =========================================================

function last(candles, n) {
  const dates = Object.keys(candles).sort();
  return dates.slice(-n).map(d => candles[d]);
}

// ---------------------------------------------------------
// 1. 三山（Triple Top）
// ---------------------------------------------------------
export function isSakataTripleTop(daily) {
  const arr = last(daily, 5);
  if (arr.length < 5) throw new Error("Not enough candles for Triple Top");

  const highs = arr.map(c => c.h);
  const h1 = highs[0], h2 = highs[2], h3 = highs[4];

  const avg = (h1 + h2 + h3) / 3;
  const tolerance = avg * 0.01; // 1%

  return (
    Math.abs(h1 - avg) < tolerance &&
    Math.abs(h2 - avg) < tolerance &&
    Math.abs(h3 - avg) < tolerance
  );
}

// ---------------------------------------------------------
// 2. 三川（Triple Bottom）
// ---------------------------------------------------------
export function isSakataTripleBottom(daily) {
  const arr = last(daily, 5);
  if (arr.length < 5) throw new Error("Not enough candles for Triple Bottom");

  const lows = arr.map(c => c.l);
  const l1 = lows[0], l2 = lows[2], l3 = lows[4];

  const avg = (l1 + l2 + l3) / 3;
  const tolerance = avg * 0.01;

  return (
    Math.abs(l1 - avg) < tolerance &&
    Math.abs(l2 - avg) < tolerance &&
    Math.abs(l3 - avg) < tolerance
  );
}

// ---------------------------------------------------------
// 3. 三空上放れ（Sanku Up）
// ---------------------------------------------------------
export function isSakataSankuUp(daily) {
  const arr = last(daily, 4);
  if (arr.length < 4) throw new Error("Not enough candles for Sanku Up");

  const c1 = arr[0], c2 = arr[1], c3 = arr[2], c4 = arr[3];

  return (
    c2.o > c1.h &&
    c3.o > c2.h &&
    c4.o > c3.h
  );
}

// ---------------------------------------------------------
// 4. 三空下放れ（Sanku Down）
// ---------------------------------------------------------
export function isSakataSankuDown(daily) {
  const arr = last(daily, 4);
  if (arr.length < 4) throw new Error("Not enough candles for Sanku Down");

  const c1 = arr[0], c2 = arr[1], c3 = arr[2], c4 = arr[3];

  return (
    c2.o < c1.l &&
    c3.o < c2.l &&
    c4.o < c3.l
  );
}

// ---------------------------------------------------------
// 5. 三兵（Sanpei Up）
// ---------------------------------------------------------
export function isSakataSanpeiUp(daily) {
  const arr = last(daily, 3);
  if (arr.length < 3) throw new Error("Not enough candles for Sanpei Up");

  const [c1, c2, c3] = arr;

  const isBull = c => c.c > c.o;

  return (
    isBull(c1) && isBull(c2) && isBull(c3) &&
    c2.o >= c1.o && c2.o <= c1.c &&
    c3.o >= c2.o && c3.o <= c2.c &&
    c2.c > c1.c &&
    c3.c > c2.c
  );
}

// ---------------------------------------------------------
// 6. 逆三兵（Sanpei Down）
// ---------------------------------------------------------
export function isSakataSanpeiDown(daily) {
  const arr = last(daily, 3);
  if (arr.length < 3) throw new Error("Not enough candles for Sanpei Down");

  const [c1, c2, c3] = arr;

  const isBear = c => c.c < c.o;

  return (
    isBear(c1) && isBear(c2) && isBear(c3) &&
    c2.o <= c1.o && c2.o >= c1.c &&
    c3.o <= c2.o && c3.o >= c2.c &&
    c2.c < c1.c &&
    c3.c < c2.c
  );
}

// ---------------------------------------------------------
// 7. 三法上放れ（Sanpo Up）
// ---------------------------------------------------------
export function isSakataSanpoUp(daily) {
  const arr = last(daily, 5);
  if (arr.length < 5) throw new Error("Not enough candles for Sanpo Up");

  const [c1, c2, c3, c4, c5] = arr;

  const isBull = c => c.c > c.o;

  const small = c => Math.abs(c.c - c.o) < (c1.c - c1.o) * 0.5;

  return (
    isBull(c1) &&
    small(c2) && small(c3) && small(c4) &&
    isBull(c5) &&
    c5.c > c1.c
  );
}

// ---------------------------------------------------------
// 8. 三法下放れ（Sanpo Down）
// ---------------------------------------------------------
export function isSakataSanpoDown(daily) {
  const arr = last(daily, 5);
  if (arr.length < 5) throw new Error("Not enough candles for Sanpo Down");

  const [c1, c2, c3, c4, c5] = arr;

  const isBear = c => c.c < c.o;

  const small = c => Math.abs(c.c - c.o) < Math.abs(c1.c - c1.o) * 0.5;

  return (
    isBear(c1) &&
    small(c2) && small(c3) && small(c4) &&
    isBear(c5) &&
    c5.c < c1.c
  );
}

// =========================================================
// 三尊（Head and Shoulders）
// =========================================================

export function isHeadAndShoulders(daily) {
  const arr = last(daily, 5);
  if (arr.length < 5) {
    throw new Error("Not enough candles for Head and Shoulders");
  }

  const [c1, c2, c3, c4, c5] = arr;

  const h1 = c1.h; // 左肩
  const h2 = c3.h; // 頭
  const h3 = c5.h; // 右肩

  const l1 = c2.l; // 谷1
  const l2 = c4.l; // 谷2

  // 条件1：高値の並び（左肩 < 頭 > 右肩）
  const cond1 = (h1 < h2) && (h3 < h2);

  // 条件2：左肩と右肩の高さが近い（±3%以内）
  const tolerance = h2 * 0.03;
  const cond2 = Math.abs(h1 - h3) < tolerance;

  // 条件3：谷が存在する（反落）
  const cond3 = (l1 < h1) && (l2 < h3);

  return cond1 && cond2 && cond3;
}

// =========================================================
// W底（Double Bottom）
// =========================================================

export function isDoubleBottom(daily) {
  const arr = last(daily, 5);
  if (arr.length < 5) {
    throw new Error("Not enough candles for Double Bottom");
  }

  const [c1, c2, c3, c4, c5] = arr;

  const low1  = c1.l; // 谷1
  const high1 = c2.h; // 反発1
  const low2  = c3.l; // 谷2
  const high2 = c4.h; // 反発2

  // 条件1：谷 → 反発 → 谷 → 反発 の形状
  const cond1 = (low1 < high1) && (low2 < high2);

  // 条件2：谷1 と谷2 が ±3% 以内
  const tolerance = high1 * 0.03;
  const cond2 = Math.abs(low1 - low2) < tolerance;

  // 条件3：谷2 が谷1 より浅い（理想的な W 底）
  const cond3 = low2 >= low1 * 0.97;

  // 条件4：反発2 が反発1 を上回る
  const cond4 = high2 > high1;

  return cond1 && cond2 && cond3 && cond4;
}

// =========================================================
// N大（上昇 N / 下降 N）
// =========================================================

export function isNichiDai(daily) {
  const arr = last(daily, 4);
  if (arr.length < 4) {
    throw new Error("Not enough candles for N Up pattern");
  }

  const [c1, c2, c3, c4] = arr;

  const low1  = c1.l;
  const high1 = c2.h;
  const low2  = c3.l;
  const high2 = c4.h;

  // 条件1：安値 → 高値 → 安値 → 高値
  const cond1 = (low1 < high1) && (low2 < high2);

  // 条件2：安値2 が安値1 より高い
  const cond2 = low2 > low1;

  // 条件3：高値2 が高値1 を上回る
  const cond3 = high2 > high1;

  return cond1 && cond2 && cond3;
}

export function isGyakuNichiDai(daily) {
  const arr = last(daily, 4);
  if (arr.length < 4) {
    throw new Error("Not enough candles for N Down pattern");
  }

  const [c1, c2, c3, c4] = arr;

  const high1 = c1.h;
  const low1  = c2.l;
  const high2 = c3.h;
  const low2  = c4.l;

  // 条件1：高値 → 安値 → 高値 → 安値
  const cond1 = (high1 > low1) && (high2 > low2);

  // 条件2：高値2 が高値1 より低い
  const cond2 = high2 < high1;

  // 条件3：安値2 が安値1 を下回る
  const cond3 = low2 < low1;

  return cond1 && cond2 && cond3;
}

// =========================================================
// ものわかれ（Monowakare Up / Down）
// =========================================================

export function isMonowakareUp(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 26) {
    throw new Error("Not enough candles for Monowakare Up");
  }

  const today = dates[dates.length - 1];
  const prev  = dates[dates.length - 2];

  const c_today = daily[today].c;
  const c_prev  = daily[prev].c;

  // 今日まで
  const todayCandles = {};
  dates.forEach(d => todayCandles[d] = daily[d]);

  // 昨日まで
  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);

  // MA5 / MA25
  const ma5_today  = calcMA(todayCandles, 5);
  const ma25_today = calcMA(todayCandles, 25);

  const ma5_prev   = calcMA(prevCandles, 5);
  const ma25_prev  = calcMA(prevCandles, 25);

  // 条件1：ローソク足が MA25 を上抜け
  const cond1 = (c_prev < ma25_prev) && (c_today > ma25_today);

  // 条件2：MA5 が MA25 を上抜け
  const cond2 = (ma5_prev < ma25_prev) && (ma5_today > ma25_today);

  return cond1 && cond2;
}

export function isMonowakareDown(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 26) {
    throw new Error("Not enough candles for Monowakare Down");
  }

  const today = dates[dates.length - 1];
  const prev  = dates[dates.length - 2];

  const c_today = daily[today].c;
  const c_prev  = daily[prev].c;

  // 今日まで
  const todayCandles = {};
  dates.forEach(d => todayCandles[d] = daily[d]);

  // 昨日まで
  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);

  // MA5 / MA25
  const ma5_today  = calcMA(todayCandles, 5);
  const ma25_today = calcMA(todayCandles, 25);

  const ma5_prev   = calcMA(prevCandles, 5);
  const ma25_prev  = calcMA(prevCandles, 25);

  // 条件1：ローソク足が MA25 を下抜け
  const cond1 = (c_prev > ma25_prev) && (c_today < ma25_today);

  // 条件2：MA5 が MA25 を下抜け
  const cond2 = (ma5_prev > ma25_prev) && (ma5_today < ma25_today);

  return cond1 && cond2;
}

// =========================================================
// ものわかれ（赤青交差：Monowakare Cross Up / Down）
// =========================================================

export function isMonowakareCrossUp(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 76) {
    throw new Error("Not enough candles for Monowakare Cross Up");
  }

  const today = dates[dates.length - 1];
  const prev  = dates[dates.length - 2];

  // 今日まで
  const todayCandles = {};
  dates.forEach(d => todayCandles[d] = daily[d]);

  // 昨日まで
  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);

  // MA5 / MA25 / MA75
  const ma5_today  = calcMA(todayCandles, 5);
  const ma25_today = calcMA(todayCandles, 25);
  const ma75_today = calcMA(todayCandles, 75);

  const ma5_prev   = calcMA(prevCandles, 5);
  const ma25_prev  = calcMA(prevCandles, 25);
  const ma75_prev  = calcMA(prevCandles, 75);

  // 条件1：MA5 が MA25 を上抜け
  const cond1 = (ma5_prev < ma25_prev) && (ma5_today > ma25_today);

  // 条件2：MA25 が MA75 を上抜け
  const cond2 = (ma25_prev < ma75_prev) && (ma25_today > ma75_today);

  return cond1 && cond2;
}

export function isMonowakareCrossDown(daily) {
  const dates = Object.keys(daily).sort();
  if (dates.length < 76) {
    throw new Error("Not enough candles for Monowakare Cross Down");
  }

  const today = dates[dates.length - 1];
  const prev  = dates[dates.length - 2];

  // 今日まで
  const todayCandles = {};
  dates.forEach(d => todayCandles[d] = daily[d]);

  // 昨日まで
  const prevCandles = {};
  dates.slice(0, -1).forEach(d => prevCandles[d] = daily[d]);

  // MA5 / MA25 / MA75
  const ma5_today  = calcMA(todayCandles, 5);
  const ma25_today = calcMA(todayCandles, 25);
  const ma75_today = calcMA(todayCandles, 75);

  const ma5_prev   = calcMA(prevCandles, 5);
  const ma25_prev  = calcMA(prevCandles, 25);
  const ma75_prev  = calcMA(prevCandles, 75);

  // 条件1：MA5 が MA25 を下抜け
  const cond1 = (ma5_prev > ma25_prev) && (ma5_today < ma25_today);

  // 条件2：MA25 が MA75 を下抜け
  const cond2 = (ma25_prev > ma75_prev) && (ma25_today < ma75_today);

  return cond1 && cond2;
}

// =========================================================
// Rule9（週足）完全実装
// =========================================================

export function computeRule9Weekly(weekly) {
  const dates = Object.keys(weekly).sort();
  const n = dates.length;
  if (n < 3) {
    return { direction: null, count: 0, over9: false, over17: false, over23: false };
  }

  // 5週線 / 100週線 を全週分計算
  const ma5 = {};
  const ma100 = {};

  for (let i = 0; i < n; i++) {
    const sub = {};
    for (let j = 0; j <= i; j++) sub[dates[j]] = weekly[dates[j]];
    ma5[dates[i]] = calcMA(sub, 5);     // 5週線
    ma100[dates[i]] = calcMA(sub, 100); // 100週線
  }

  // 状態管理
  let ruleDir = null;          // "up" | "down" | null
  let ruleStartIndex = null;   // 起点インデックス
  let ruleCount = 0;

  // 直近トレンド区間の最安終値 / 最高終値
  let segmentLow = Infinity;
  let segmentLowIndex = null;

  let segmentHigh = -Infinity;
  let segmentHighIndex = null;

  // 前週の終値
  let prevClose = weekly[dates[0]].c;

  // 初期セグメント
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

    // -----------------------------------------------------
    // 100週線跨ぎ → 即リセット & 新規カウント開始
    // -----------------------------------------------------
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

    // -----------------------------------------------------
    // トレンド判定（終値のみ）
    // -----------------------------------------------------
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

    // -----------------------------------------------------
    // Rule9 カウント中の処理
    // -----------------------------------------------------
    if (ruleDir === "up") {
      // 5週線割れ → 終了
      if (c < todayMA5) {
        ruleDir = null;
        ruleCount = 0;
        prevClose = c;
        continue;
      }

      // 終値が前週以上 → 継続
      if (c >= prevClose) {
        ruleCount++;
      } else {
        // 終値が下落 → 終了
        ruleDir = null;
        ruleCount = 0;
      }

      prevClose = c;
      continue;
    }

    if (ruleDir === "down") {
      // 5週線超え → 終了
      if (c > todayMA5) {
        ruleDir = null;
        ruleCount = 0;
        prevClose = c;
        continue;
      }

      // 終値が前週以下 → 継続
      if (c <= prevClose) {
        ruleCount++;
      } else {
        // 終値が上昇 → 終了
        ruleDir = null;
        ruleCount = 0;
      }

      prevClose = c;
      continue;
    }

    // -----------------------------------------------------
    // Rule9 カウント開始判定（新規トレンド発生）
    // -----------------------------------------------------
    if (upMove) {
      // 直前は下降トレンド → segmentLowIndex が起点
      ruleDir = "up";
      ruleStartIndex = segmentLowIndex;
      ruleCount = i - segmentLowIndex + 1;
    } else if (downMove) {
      // 直前は上昇トレンド → segmentHighIndex が起点
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
