/********************************************************************************************
 * heuristics.js — heuristics_YYYYMMDD.json 生成
 ********************************************************************************************/

import fetch from "node-fetch";
import fs from "fs";
import xlsx from "xlsx";
import path from "path";

import hc from "./heuristics_conditions.js";

/* ==========================================================================================
   1. Excel から銘柄コードを読み込む
========================================================================================== */

const workbook = xlsx.readFile("data/data_j.xlsx");
const sheet = workbook.Sheets["Sheet1"];
const rows = xlsx.utils.sheet_to_json(sheet);

let symbols = rows
  .map(r => String(r["コード"]).trim())
  .filter(code => code && code !== "undefined");

if (symbols.length === 0) {
  console.log("ERROR: Excel から銘柄コードが読み取れませんでした。");
  process.exit(1);
}



// ---------------------------------------------------------
// ★ テストモード（複数銘柄で動作確認したいときに使用）
//    有効化したいときは↓のコメントアウトを外すだけでOK
// ---------------------------------------------------------

// テストしたい銘柄コードを複数指定（例：7203）
const TEST_SYMBOLS = [
  // データ少ない
  "5585", "5132", "5026", "4259",

  // 上昇トレンド
  "7203", "8306", "6861",

  // 下降トレンド
  "4755", "9984",

  // ボラ高
  "1514", "4165", "7373",
  
  // 必要に応じて追加
];

console.log("=== TEST MODE ENABLED ===");
console.log(`Target symbols: ${TEST_SYMBOLS.join(", ")}`);

// symbols を複数銘柄に絞る
symbols = symbols.filter(code => TEST_SYMBOLS.includes(code));

if (symbols.length === 0) {
  console.log(`ERROR: TEST_SYMBOLS の銘柄が Excel に 1 つも存在しません。`);
  process.exit(1);
}
// ---------------------------------------------------------
// ★ テストモード（複数銘柄）↑↑ここまで。
// ---------------------------------------------------------



/* ==========================================================================================
   2. Yahoo Finance API（足種別に取得）
========================================================================================== */

async function fetchCandles(code, interval, range) {
  const symbol = `${code}.T`;  // ← Yahoo API 用に .T を付ける
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


/* ==========================================================================================
   3. 条件実行まとめ
========================================================================================== */

function runAllConditions(daily, weekly, monthly) {
  const slope = (up, down) => (up ? "up" : down ? "down" : "flat");
  const mono = (up, down) => (up ? "up" : down ? "down" : "flat");

  const rule9Daily = hc.computeRule9Daily(daily);
  const rule9Weekly = hc.computeRule9Weekly(weekly);

  const fushimeUp = hc.computeFushimeUp(daily);
  const fushimeDown = hc.computeFushimeDown(daily);

  const granville = hc.computeGranville(daily);
  const cycle = hc.computeCycleProgress(daily);

  return {
    /* MA SLOPE */
    TECH_MA_SLOPE_DAILY: slope(hc.isMaSlopeUpDaily(daily), hc.isMaSlopeDownDaily(daily)),
    TECH_MA_SLOPE_WEEKLY: slope(hc.isMaSlopeUpWeekly(weekly), hc.isMaSlopeDownWeekly(weekly)),
    TECH_MA_SLOPE_MONTHLY: slope(hc.isMaSlopeUpMonthly(monthly), hc.isMaSlopeDownMonthly(monthly)),

    /* MA POSITION */
    TECH_MA_POSITION_DAILY: hc.isMaPositionDaily(daily),
    TECH_MA_POSITION_WEEKLY: hc.isMaPositionWeekly(weekly),
    TECH_MA_POSITION_MONTHLY: hc.isMaPositionMonthly(monthly),

    /* PERFECT ORDER */
    TECH_PERFECT_ORDER_DAILY: hc.isPerfectOrderDaily(daily),
    TECH_PERFECT_ORDER_WEEKLY: hc.isPerfectOrderWeekly(weekly),
    TECH_PERFECT_ORDER_MONTHLY: hc.isPerfectOrderMonthly(monthly),

    TECH_REVERSE_PERFECT_ORDER_DAILY: hc.isReversePerfectOrderDaily(daily),
    TECH_REVERSE_PERFECT_ORDER_WEEKLY: hc.isReversePerfectOrderWeekly(weekly),
    TECH_REVERSE_PERFECT_ORDER_MONTHLY: hc.isReversePerfectOrderMonthly(monthly),

    /* PRE-PO / PRE-RPO */
    TECH_PRE_PERFECT_ORDER_DAILY: hc.isPrePerfectOrderDaily(daily),
    TECH_PRE_PERFECT_ORDER_WEEKLY: hc.isPrePerfectOrderWeekly(weekly),
    TECH_PRE_PERFECT_ORDER_MONTHLY: hc.isPrePerfectOrderMonthly(monthly),

    TECH_PRE_REVERSE_PERFECT_ORDER_DAILY: hc.isPreReversePerfectOrderDaily(daily),
    TECH_PRE_REVERSE_PERFECT_ORDER_WEEKLY: hc.isPreReversePerfectOrderWeekly(weekly),
    TECH_PRE_REVERSE_PERFECT_ORDER_MONTHLY: hc.isPreReversePerfectOrderMonthly(monthly),

    /* MA CONGESTION */
    TECH_MA_CONGESTION: hc.isMaCongestion(daily),

    /* MA SPREAD */
    TECH_MA_SPREAD: slope(
      hc.isMaSpreadUp(daily) === "up",
      hc.isMaSpreadUp(daily) === "down"
    ),

    /* MA100 TREND */
    TECH_MA100_TREND: hc.isMa100Trend(daily),

    /* 下半身 */
    TECH_KAHANSHIN: hc.isKahanshin(daily),
    TECH_GYAKU_KAHANSHIN: hc.isGyakuKahanshin(daily),

    /* 5MA UPDATE */
    TECH_5MA_UPDATE: slope(
      hc.is5MaHighUpdate(daily),
      hc.is5MaLowUpdate(daily)
    ),

    /* 酒田五法 */
    TECH_SAKATA_TRIPLE_TOP: hc.isSakataTripleTop(daily) ? 1 : null,
    TECH_SAKATA_TRIPLE_BOTTOM: hc.isSakataTripleBottom(daily) ? 1 : null,
    TECH_SAKATA_SANKU_UP: hc.isSakataSankuUp(daily) ? 1 : null,
    TECH_SAKATA_SANKU_DOWN: hc.isSakataSankuDown(daily) ? 1 : null,
    TECH_SAKATA_SANPEI_UP: hc.isSakataSanpeiUp(daily) ? 1 : null,
    TECH_SAKATA_SANPEI_DOWN: hc.isSakataSanpeiDown(daily) ? 1 : null,
    TECH_SAKATA_SANPO_UP: hc.isSakataSanpoUp(daily) ? 1 : null,
    TECH_SAKATA_SANPO_DOWN: hc.isSakataSanpoDown(daily) ? 1 : null,

    /* パターン */
    TECH_HEAD_AND_SHOULDERS: hc.isHeadAndShoulders(daily),
    TECH_DOUBLE_BOTTOM: hc.isDoubleBottom(daily),
    TECH_NICHI_DAI: hc.isNichiDai(daily),
    TECH_GYAKU_NICHI_DAI: hc.isGyakuNichiDai(daily),

    TECH_MONOWAKARE: mono(hc.isMonowakareUp(daily), hc.isMonowakareDown(daily)),
    TECH_MONOWAKARE_RED_BLUE_CROSS: mono(
      hc.isMonowakareRedBlueCrossUp(daily),
      hc.isMonowakareRedBlueCrossDown(daily)
    ),

    /* Rule9 */
    TECH_RULE9_DAILY: rule9Daily,
    TECH_RULE9_WEEKLY: rule9Weekly,

    /* BB ZONE BREAK（boolean） */
    TECH_BB_ZONE_BREAK_DAILY: hc.isBbZoneBreakDaily(daily),
    TECH_BB_ZONE_BREAK_WEEKLY: hc.isBbZoneBreakWeekly(weekly),
    TECH_BB_ZONE_BREAK_MONTHLY: hc.isBbZoneBreakMonthly(monthly),

    /* BOX RANGE */
    TECH_BOX_RANGE: hc.isBoxRange(daily),

    /* OVERHEAT */
    TECH_OVERHEAT: hc.isOverheat(daily),

    /* GRANVILLE */
    TECH_GRANVILLE: granville,

    /* In-In / ReturnSellEnd / DownTrendEnd / Momiai */
    TECH_IN_IN_HARAMI: hc.isInInHarami(daily),
    TECH_RETURN_SELL_END: hc.isReturnSellEnd(daily),
    TECH_DOWN_TREND_END: hc.isDownTrendEnd(daily),
    TECH_MOMIAI: hc.isMomiai(daily),

    /* Cycle Progress（number|null） */
    TECH_CYCLE_PROGRESS: cycle ? cycle.daysFromLastSwing : null,

    /* Fushime */
    TECH_FUSHIME_UP: fushimeUp,
    TECH_FUSHIME_DOWN: fushimeDown
  };
}

/* ==========================================================================================
   4. メイン処理
========================================================================================== */

async function main() {
  let finalData = {};
  let latestDateGlobal = null;

  for (const code of symbols) {
    console.log(`Processing ${code} ...`);

    const daily = await fetchCandles(code, "1d", "1y");
    const weekly = await fetchCandles(code, "1wk", "5y");
    const monthly = await fetchCandles(code, "1mo", "10y");

    // --- データ不足チェック（fetchCandles の error を検出） ---
    if (daily.error || weekly.error || monthly.error) {
      console.log(`Skipping ${code} due to fetch error:`, {
        daily: daily.error,
        weekly: weekly.error,
        monthly: monthly.error
      });
      finalData[code] = { error: "fetch error" };
      continue;
    }
  
    // --- ローソク足が少なすぎる場合もスキップ ---
    const needDaily   = 100; // Rule9 daily
    const needWeekly  = 100; // Rule9 weekly
    const needMonthly = 75;  // MA75, PO, RPO, etc.
    
    const dailyCount   = Object.keys(daily).length;
    const weeklyCount  = Object.keys(weekly).length;
    const monthlyCount = Object.keys(monthly).length;
    
    // 判定
    const insufficient =
      dailyCount < needDaily || weeklyCount < needWeekly || monthlyCount < needMonthly;

    if (insufficient) {
      const dailyMsg = `${dailyCount}  ${dailyCount >= needDaily ? ">" : "<"} ${needDaily} required`;
      const weeklyMsg = `${weeklyCount} ${weeklyCount >= needWeekly ? ">" : "<"} ${needWeekly} required`;
      const monthlyMsg = `${monthlyCount} ${monthlyCount >= needMonthly ? ">" : "<"} ${needMonthly} required`;

      console.log(`Skipping ${code} due to insufficient candles. {`);
      console.log(`  daily:   ${dailyMsg},`);
      console.log(`  weekly:  ${weeklyMsg},`);
      console.log(`  monthly: ${monthlyMsg}`);
      console.log(`}`);
      finalData[code] = { error: "insufficient candles" };
      continue;
    }

    // 最新日付を更新
    const latestDate = Object.keys(daily).sort().pop();
    if (!latestDateGlobal || latestDate > latestDateGlobal) {
      latestDateGlobal = latestDate;
    }

    finalData[code] = runAllConditions(daily, weekly, monthly);

    await new Promise(r => setTimeout(r, 500));
  }

  /* 保存先フォルダ（data/heuristics/YYYYMM）を作成 */
  const yyyymm = latestDateGlobal.slice(0, 6);
  const heuristicsDir = `data/heuristics/${yyyymm}`;
  if (!fs.existsSync(heuristicsDir)) fs.mkdirSync(heuristicsDir, { recursive: true });

  /* heuristics_YYYYMMDD.json を保存 */
  const outFile = `${heuristicsDir}/heuristics_${latestDateGlobal}.json`;
  fs.writeFileSync(outFile, JSON.stringify(finalData, null, 2));

  /* バックアップ処理（data/backup/heuristics_YYYYMMDD.json.TIMESTAMP） */
  const backupDir = "data/backup";
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, "0");

  const timestamp =
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "_" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds());

  const backupFile = path.join(backupDir, `heuristics_${latestDateGlobal}.json.${timestamp}`);
  fs.copyFileSync(outFile, backupFile);

  /* バックアップ最新 8 件だけ残す */
  const files = fs
    .readdirSync(backupDir)
    .filter(f => f.startsWith("heuristics_") && f.includes(".json."))
    .sort();

  while (files.length > 8) {
    const oldFile = files.shift();
    fs.unlinkSync(path.join(backupDir, oldFile));
  }

  console.log(`heuristics_${latestDateGlobal}.json generation completed.`);
}

main();
