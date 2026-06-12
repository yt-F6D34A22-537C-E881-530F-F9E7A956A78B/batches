import fetch from "node-fetch";
import fs from "fs";
import xlsx from "xlsx";
import path from "path";

// ---------------------------------------------------------
// 1. Excel から銘柄コードを読み込む（パス修正）
// ---------------------------------------------------------
const workbook = xlsx.readFile("data/data_j.xlsx");
const sheet = workbook.Sheets["Sheet1"];
const rows = xlsx.utils.sheet_to_json(sheet);

let symbols = rows
  .map(r => String(r["コード"]).trim())
  .filter(code => code && code !== "undefined")
  .map(code => `${code}.T`);

if (symbols.length === 0) {
  console.log("ERROR: Excel から銘柄コードが読み取れませんでした。");
  process.exit(1);
}



// ---------------------------------------------------------
// ★ テストモード（1銘柄だけで動作確認したいときに使用）
// ---------------------------------------------------------
// テストしたい銘柄コードを指定（例：7203.T）
// 有効化したいときは↓のコメントアウトを外すだけでOK
const TEST_SYMBOL = "7203.T";  // ← 任意の銘柄に変更可能

console.log("=== TEST MODE ENABLED ===");
console.log(`Target symbol: ${TEST_SYMBOL}`);

// symbols を 1 銘柄だけに絞る
symbols = symbols.filter(s => s === TEST_SYMBOL);

if (symbols.length === 0) {
  console.log(`ERROR: TEST_SYMBOL ${TEST_SYMBOL} が Excel に存在しません。`);
  process.exit(1);
}
// ---------------------------------------------------------
// ★ テストモード（1銘柄だけで動作確認したいときに使用）↑↑ここまで。
// ---------------------------------------------------------



// ---------------------------------------------------------
// 2. Yahoo Finance API（足種別に取得）
// ---------------------------------------------------------
async function fetchCandles(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;

  try {
    const res = await fetch(url);
    const json = await res.json();

    if (!json.chart || !json.chart.result) {
      return { error: json.chart?.error?.description || "Unknown error from Yahoo Finance" };
    }

    const item = json.chart.result[0];
    const timestamps = item.timestamp;
    const q = item.indicators.quote[0];

    if (!timestamps || timestamps.length < 10) {
      return { error: "Too few candles returned from Yahoo API" };
    }
    if (!q || !q.close || q.close.length < 10) {
      return { error: "Too few quote entries returned from Yahoo API" };
    }
    
    let result = {};
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const date = new Date(ts * 1000);

      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      const key = `${y}${m}${d}`;

      result[key] = {
        o: q.open[i],
        h: q.high[i],
        l: q.low[i],
        c: q.close[i],
        v: q.volume[i]
      };
    }
    
    return result;

  } catch (err) {
    return { error: "Network or fetch error" };
  }
}

// ---------------------------------------------------------
// 3. heuristics_conditions.js（現行関数のみ import）
// ---------------------------------------------------------
import {
  isMaSlopeUpDaily, isMaSlopeDownDaily,
  isMaSlopeUpWeekly, isMaSlopeDownWeekly,
  isMaSlopeUpMonthly, isMaSlopeDownMonthly,
  isPerfectOrderDaily, isReversePerfectOrderDaily,
  isPerfectOrderWeekly, isReversePerfectOrderWeekly,
  isPerfectOrderMonthly, isReversePerfectOrderMonthly,
  isPrePerfectOrder, isPreReversePerfectOrder,
  isMaCongestionUp, isMaCongestionDown,
  isMaSpreadUp, isMaSpreadDown,
  isMa100TrendUp, isMa100TrendDown,
  isKahanshin, isGyakuKahanshin,
  is5MaHighUpdate, is5MaLowUpdate,
  isSakataTripleTop, isSakataTripleBottom,
  isSakataSankuUp, isSakataSankuDown,
  isSakataSanpeiUp, isSakataSanpeiDown,
  isSakataSanpoUp, isSakataSanpoDown,
  isHeadAndShoulders,
  isDoubleBottom,
  isNichiDai, isGyakuNichiDai,
  isMonowakareUp, isMonowakareDown,
  isMonowakareCrossUp, isMonowakareCrossDown,
  computeRule9Daily, computeRule9Weekly,
  isRule9DailyUp9, isRule9DailyUp17, isRule9DailyUp23,
  isRule9DailyDown9, isRule9DailyDown17, isRule9DailyDown23,
  isRule9WeeklyUp9, isRule9WeeklyUp17, isRule9WeeklyUp23,
  isRule9WeeklyDown9, isRule9WeeklyDown17, isRule9WeeklyDown23,
} from "./heuristics_conditions.js";

// ---------------------------------------------------------
// 4. 条件実行まとめ
// ---------------------------------------------------------
function runAllConditions(daily, weekly, monthly) {
  return {
    TECH_MA_SLOPE_UP_DAILY: isMaSlopeUpDaily(daily),
    TECH_MA_SLOPE_DOWN_DAILY: isMaSlopeDownDaily(daily),
    TECH_MA_SLOPE_UP_WEEKLY: isMaSlopeUpWeekly(weekly),
    TECH_MA_SLOPE_DOWN_WEEKLY: isMaSlopeDownWeekly(weekly),
    TECH_MA_SLOPE_UP_MONTHLY: isMaSlopeUpMonthly(monthly),
    TECH_MA_SLOPE_DOWN_MONTHLY: isMaSlopeDownMonthly(monthly),

    TECH_MA_PO_DAILY: isPerfectOrderDaily(daily),
    TECH_MA_RPO_DAILY: isReversePerfectOrderDaily(daily),
    TECH_MA_PO_WEEKLY: isPerfectOrderWeekly(weekly),
    TECH_MA_RPO_WEEKLY: isReversePerfectOrderWeekly(weekly),
    TECH_MA_PO_MONTHLY: isPerfectOrderMonthly(monthly),
    TECH_MA_RPO_MONTHLY: isReversePerfectOrderMonthly(monthly),

    TECH_MA_PRE_PO: isPrePerfectOrder(daily),
    TECH_MA_PRE_RPO: isPreReversePerfectOrder(daily),

    TECH_MA_CONGESTION_UP: isMaCongestionUp(daily),
    TECH_MA_CONGESTION_DOWN: isMaCongestionDown(daily),

    TECH_MA_SPREAD_UP: isMaSpreadUp(daily),
    TECH_MA_SPREAD_DOWN: isMaSpreadDown(daily),

    TECH_MA100_TREND_UP: isMa100TrendUp(daily),
    TECH_MA100_TREND_DOWN: isMa100TrendDown(daily),

    TECH_KAHANSHIN: isKahanshin(daily),
    TECH_GYAKU_KAHANSHIN: isGyakuKahanshin(daily),

    TECH_5MA_HIGH_UPDATE: is5MaHighUpdate(daily),
    TECH_5MA_LOW_UPDATE: is5MaLowUpdate(daily),

    TECH_SAKATA_TRIPLE_TOP: isSakataTripleTop(daily),
    TECH_SAKATA_TRIPLE_BOTTOM: isSakataTripleBottom(daily),
    TECH_SAKATA_SANKU_UP: isSakataSankuUp(daily),
    TECH_SAKATA_SANKU_DOWN: isSakataSankuDown(daily),
    TECH_SAKATA_SANPEI_UP: isSakataSanpeiUp(daily),
    TECH_SAKATA_SANPEI_DOWN: isSakataSanpeiDown(daily),
    TECH_SAKATA_SANPO_UP: isSakataSanpoUp(daily),
    TECH_SAKATA_SANPO_DOWN: isSakataSanpoDown(daily),

    TECH_HEAD_AND_SHOULDERS: isHeadAndShoulders(daily),
    TECH_DOUBLE_BOTTOM: isDoubleBottom(daily),
    TECH_NICHI_DAI: isNichiDai(daily),
    TECH_GYAKU_NICHI_DAI: isGyakuNichiDai(daily),

    TECH_MONOWAKARE_UP: isMonowakareUp(daily),
    TECH_MONOWAKARE_DOWN: isMonowakareDown(daily),
    TECH_MONOWAKARE_CROSS_UP: isMonowakareCrossUp(daily),
    TECH_MONOWAKARE_CROSS_DOWN: isMonowakareCrossDown(daily),

    TECH_RULE9_DAILY: computeRule9Daily(daily),
    TECH_RULE9_WEEKLY: computeRule9Weekly(weekly),

    TECH_RULE9_DAILY_UP_9: isRule9DailyUp9(daily),
    TECH_RULE9_DAILY_UP_17: isRule9DailyUp17(daily),
    TECH_RULE9_DAILY_UP_23: isRule9DailyUp23(daily),

    TECH_RULE9_DAILY_DOWN_9: isRule9DailyDown9(daily),
    TECH_RULE9_DAILY_DOWN_17: isRule9DailyDown17(daily),
    TECH_RULE9_DAILY_DOWN_23: isRule9DailyDown23(daily),

    TECH_RULE9_WEEKLY_UP_9: isRule9WeeklyUp9(weekly),
    TECH_RULE9_WEEKLY_UP_17: isRule9WeeklyUp17(weekly),
    TECH_RULE9_WEEKLY_UP_23: isRule9WeeklyUp23(weekly),

    TECH_RULE9_WEEKLY_DOWN_9: isRule9WeeklyDown9(weekly),
    TECH_RULE9_WEEKLY_DOWN_17: isRule9WeeklyDown17(weekly),
    TECH_RULE9_WEEKLY_DOWN_23: isRule9WeeklyDown23(weekly),
  };
}

// ---------------------------------------------------------
// 5. メイン処理（パス修正済み）
// ---------------------------------------------------------
async function main() {
  let finalData = {};

  for (const symbol of symbols) {
    console.log(`Processing ${symbol} ...`);

    const daily = await fetchCandles(symbol, "1d", "1y");
    const weekly = await fetchCandles(symbol, "1wk", "5y");
    const monthly = await fetchCandles(symbol, "1mo", "10y");

    // --- データ不足チェック（fetchCandles の error を検出） ---
    if (daily.error || weekly.error || monthly.error) {
      console.log(`Skipping ${symbol} due to fetch error:`, {
        daily: daily.error,
        weekly: weekly.error,
        monthly: monthly.error
      });
      finalData[symbol] = { error: "fetch error" };
      continue;
    }
  
    // --- ローソク足が少なすぎる場合もスキップ ---
    if (Object.keys(daily).length < 120 ||
        Object.keys(weekly).length < 120 ||
        Object.keys(monthly).length < 120) {
      
      console.log(`Skipping ${symbol} due to insufficient candles.`, {
        daily: Object.keys(daily).length,
        weekly: Object.keys(weekly).length,
        monthly: Object.keys(monthly).length
      });

      // テストモードでは即終了
      if (symbols.length === 1) {
        console.log("Test mode: exiting early due to insufficient candles.");
        return;
      }
      
      finalData[symbol] = { error: "insufficient candles" };
      continue;
    }

    finalData[symbol] = runAllConditions(daily, weekly, monthly);

    await new Promise(r => setTimeout(r, 500));
  }

  fs.writeFileSync("data/heuristics.json", JSON.stringify(finalData, null, 2));

  const backupDir = "data/backup";
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, "0");

  const timestamp =
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) + "_" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds());

  const backupFile = path.join(backupDir, `heuristics.json.${timestamp}`);
  fs.copyFileSync("data/heuristics.json", backupFile);

  const files = fs
    .readdirSync(backupDir)
    .filter(f => f.startsWith("heuristics.json."))
    .sort();

  while (files.length > 8) {
    const oldFile = files.shift();
    fs.unlinkSync(path.join(backupDir, oldFile));
  }

  console.log("heuristics.json generation completed.");
}

main();
