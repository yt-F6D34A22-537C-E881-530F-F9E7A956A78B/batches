/********************************************************************************************
 * heuristics.js — heuristics_YYYYMMDD.json 生成
 ********************************************************************************************/

import fetch from "node-fetch";
import fs from "fs";
import xlsx from "xlsx";
import { execSync } from "child_process";
// backupFileは、この関数内で使う既存のローカル変数名（コピー先パス）と紛らわしいため
// createBackupという別名でインポートしている。
import { backupFile as createBackup, pruneKeepNewest } from "./lib/backup_utils.js";
import { mapWithConcurrency } from "./lib/concurrency.js";
import { resampleWeekly, resampleMonthly, sliceDailyUpTo } from "./lib/ohlcv_resample.js";

import * as hc from "./lib/heuristics_conditions.js";

/* ==========================================================================================
   0. コマンドライン引数のパース
      --date  YYYYMMDD   : 単一日指定（その日を終端として取得）
      --from  YYYYMMDD   : 期間指定・開始日（--to とペアで使用）
      --to    YYYYMMDD   : 期間指定・終了日（--from とペアで使用）
      引数なし           : 従来通り（Yahoo Finance 最新日付を自動取得）

   ⚠️ このスクリプトは data/data.json を読み書きしない。
      fetch.js とは独立して Yahoo Finance API へ直接アクセスする。
      指定日モードでも data/data.json は一切変更されない。
========================================================================================== */

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { singleDate: null, fromDate: null, toDate: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) { result.singleDate = args[i + 1].trim(); i++; }
    if (args[i] === "--from" && args[i + 1]) { result.fromDate   = args[i + 1].trim(); i++; }
    if (args[i] === "--to"   && args[i + 1]) { result.toDate     = args[i + 1].trim(); i++; }
  }
  return result;
}

const { singleDate, fromDate, toDate } = parseArgs();

// --- 引数バリデーション ---
const DATE_RE = /^\d{8}$/;

if (singleDate && !DATE_RE.test(singleDate)) {
  console.log(`ERROR: --date の形式が不正です（YYYYMMDD で指定してください）: ${singleDate}`);
  process.exit(1);
}
if (fromDate && !DATE_RE.test(fromDate)) {
  console.log(`ERROR: --from の形式が不正です（YYYYMMDD で指定してください）: ${fromDate}`);
  process.exit(1);
}
if (toDate && !DATE_RE.test(toDate)) {
  console.log(`ERROR: --to の形式が不正です（YYYYMMDD で指定してください）: ${toDate}`);
  process.exit(1);
}
if ((fromDate && !toDate) || (!fromDate && toDate)) {
  console.log("ERROR: --from と --to は両方指定してください。");
  process.exit(1);
}
if (fromDate && toDate && fromDate > toDate) {
  console.log(`ERROR: --from（${fromDate}）は --to（${toDate}）以前である必要があります。`);
  process.exit(1);
}
if (singleDate && (fromDate || toDate)) {
  console.log("ERROR: --date と --from/--to は同時に指定できません。");
  process.exit(1);
}

// --- 実行モードを確定 ---
const RUN_MODE = singleDate ? "single" : (fromDate ? "range" : "normal");

console.log(`=== Run mode: ${RUN_MODE} ===`);
if (RUN_MODE === "single") console.log(`Target date: ${singleDate}`);
if (RUN_MODE === "range")  console.log(`Target range: ${fromDate} ～ ${toDate}`);

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



// // ---------------------------------------------------------
// // ★ テストモード（複数銘柄で動作確認したいときに使用）
// //    有効化したいときは↓のコメントアウトを外すだけでOK
// // ---------------------------------------------------------

// // テストしたい銘柄コードを複数指定（例：7203）
// const TEST_SYMBOLS = [
//   // データ少ない
//   "5585", "5132", "5026", "4259",

//   // 上昇トレンド
//   "7203", "8306", "6861",

//   // 下降トレンド
//   "4755", "9984",

//   // ボラ高
//   "1514", "4165", "7373",
  
//   // 必要に応じて追加
// ];

// console.log("=== TEST MODE ENABLED ===");
// console.log(`Target symbols: ${TEST_SYMBOLS.join(", ")}`);

// // symbols を複数銘柄に絞る
// symbols = symbols.filter(code => TEST_SYMBOLS.includes(code));

// if (symbols.length === 0) {
//   console.log(`ERROR: TEST_SYMBOLS の銘柄が Excel に 1 つも存在しません。`);
//   process.exit(1);
// }
// // ---------------------------------------------------------
// // ★ テストモード（複数銘柄）↑↑ここまで。
// // ---------------------------------------------------------



/* ==========================================================================================
   2. Yahoo Finance API（日足のみ取得。週足・月足はローカルで集計する）

   ⚠️ この関数は data/data.json を読み書きしない。
      通常モード・指定日モードともに Yahoo Finance API へ直接アクセスする。

   2026-07: 週足・月足をYahoo Finance APIから直接取得すると値が不安定になることがある
   （実運用で確認）ため、日足のみを取得し、週足・月足はバックエンド（main.py の /chart。
   pandasの df.resample("W-FRI") / df.resample("ME")）と同一の集計規則で
   scripts/lib/ohlcv_resample.js によりローカル生成するように変更した。
   これにより銘柄あたりのAPIリクエスト数が3回→1回に減る副次効果もある。
========================================================================================== */

/**
 * YYYYMMDD 文字列を「翌日 00:00 JST の UNIX 秒」に変換する（period2 に使用）。
 * 指定日自体を含めるために翌日 00:00 JST（= 当日 15:00 UTC）を終端とする。
 */
function toUnixEndOfDay(yyyymmdd) {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  // 翌日 00:00 JST = UTC で (翌日 00:00) - 9h
  const utcMs = Date.UTC(y, m, d + 1) - 9 * 60 * 60 * 1000;
  return Math.floor(utcMs / 1000);
}

// 日足の遡及日数。週足・月足をローカル集計するため、旧実装の週足用（1900日）・
// 月足用（3700日）双方の必要期間をカバーできるよう、両者のうち大きい方（月足用）を採用する。
const DAILY_LOOKBACK_DAYS = 3700;

// 通常モード（targetDateなし）時の range 指定。週足・月足をローカル集計するため、
// 旧実装の日足用range（"1y"）ではなく、月足の集計に必要な期間（旧"10y"）に合わせて拡大している。
const DAILY_RANGE_NORMAL = "10y";

/**
 * @param {string} code        - 銘柄コード（4桁）
 * @param {string|null} targetDate  - YYYYMMDD（指定日/期間モード。取得終端＝period2）または null（通常モード）
 * @param {string|null} period1AnchorDate - period1（遡及開始日）の基準日。省略時は targetDate を使う。
 *   期間モードでは、範囲内で最も古い対象日（fromDate）をここに渡すことで、
 *   「範囲内のどの対象日についても、その日自身が必要とするDAILY_LOOKBACK_DAYS分の
 *   遡及期間を確保する」ことができる（toDateを基準にperiod1を計算すると、
 *   fromDate〜toDateの日数分だけ遡及期間が不足してしまうため。2026-07 修正）。
 */
async function fetchDailyCandles(code, targetDate = null, period1AnchorDate = null) {
  const symbol = `${code}.T`;  // ← Yahoo API 用に .T を付ける

  let url;
  if (targetDate) {
    // 指定日/期間モード: period1/period2 で期間を固定し、targetDateを終端とする
    const period2 = toUnixEndOfDay(targetDate);
    const period1 = toUnixEndOfDay(period1AnchorDate ?? targetDate) - DAILY_LOOKBACK_DAYS * 24 * 60 * 60;
    url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${period1}&period2=${period2}`;
  } else {
    // 通常モード: 従来通り range 指定
    url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${DAILY_RANGE_NORMAL}`;
  }

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
   2.5 全銘柄の日足をまとめて取得する（同時実行数を制限したプールで並列化）

   2026-07 新設。旧実装は「1銘柄ずつ直列で3リクエスト（日足/週足/月足）+ 固定500msスリープ」
   だったため、約4,400銘柄で1日分の処理に1〜2時間程度を要していた。
   日足のみの取得に一本化した上で、同時実行数を制限したプール（scripts/lib/concurrency.js）で
   並列化することで大幅に短縮する。
========================================================================================== */

// Yahoo Finance側のレート制限に配慮した初期値。エラー率が高い場合は下げ、
// 安定していれば上げるなど、実地の様子を見て調整すること。
const FETCH_CONCURRENCY = 8;

/**
 * @param {string|null} targetDate - YYYYMMDD（指定日/期間モード時の取得終端日）または null（通常モード）
 * @param {string|null} period1AnchorDate - period1（遡及開始日）の基準日。省略時は targetDate を使う。
 *   期間モードでは fromDate（範囲内最古の対象日）を渡す（詳細は fetchDailyCandles を参照）。
 * @returns {Promise<Map<string, object>>} - code -> 日足OHLCVオブジェクト（取得失敗時は{error}）
 */
async function fetchAllSymbolsDaily(targetDate, period1AnchorDate = null) {
  const dailyByCode = new Map();
  let doneCount = 0;

  await mapWithConcurrency(symbols, FETCH_CONCURRENCY, async (code) => {
    const daily = await fetchDailyCandles(code, targetDate, period1AnchorDate);
    dailyByCode.set(code, daily);
    doneCount++;
    if (doneCount % 200 === 0 || doneCount === symbols.length) {
      console.log(`日足取得進捗: ${doneCount}/${symbols.length}`);
    }
  });

  return dailyByCode;
}


/* ==========================================================================================
   3. 条件実行まとめ
========================================================================================== */

function runAllConditions(daily, weekly, monthly) {
  const slope = (up, down) => (up ? "up" : down ? "down" : "flat");
  const mono  = (up, down) => (up ? "up" : down ? "down" : "flat");

  const rule9Daily  = hc.computeRule9Daily(daily);
  const rule9Weekly = hc.computeRule9Weekly(weekly);

  const fushimeUp   = hc.computeFushimeUp(daily);
  const fushimeDown = hc.computeFushimeDown(daily);

  const granville = hc.computeGranville(daily);
  const cycle     = hc.computeCycleProgress(daily);

  return {
    /* 移動平均線の傾き */
    TECH_MA_SLOPE_DAILY:   slope(hc.isMaSlopeUpDaily(daily),   hc.isMaSlopeDownDaily(daily)),
    TECH_MA_SLOPE_WEEKLY:  slope(hc.isMaSlopeUpWeekly(weekly), hc.isMaSlopeDownWeekly(weekly)),
    TECH_MA_SLOPE_MONTHLY: slope(hc.isMaSlopeUpMonthly(monthly), hc.isMaSlopeDownMonthly(monthly)),

    /* 移動平均線の位置 */
    TECH_MA_POSITION_DAILY:   hc.isMaPositionDaily(daily),
    TECH_MA_POSITION_WEEKLY:  hc.isMaPositionWeekly(weekly),
    TECH_MA_POSITION_MONTHLY: hc.isMaPositionMonthly(monthly),

    /* パーフェクトオーダー */
    TECH_PERFECT_ORDER_DAILY:   hc.isPerfectOrderDaily(daily),
    TECH_PERFECT_ORDER_WEEKLY:  hc.isPerfectOrderWeekly(weekly),
    TECH_PERFECT_ORDER_MONTHLY: hc.isPerfectOrderMonthly(monthly),

    /* 逆パーフェクトオーダー */
    TECH_REVERSE_PERFECT_ORDER_DAILY:   hc.isReversePerfectOrderDaily(daily),
    TECH_REVERSE_PERFECT_ORDER_WEEKLY:  hc.isReversePerfectOrderWeekly(weekly),
    TECH_REVERSE_PERFECT_ORDER_MONTHLY: hc.isReversePerfectOrderMonthly(monthly),

    /* パーフェクトオーダー前夜 */
    TECH_PRE_PERFECT_ORDER_DAILY:   hc.isPrePerfectOrderDaily(daily),
    TECH_PRE_PERFECT_ORDER_WEEKLY:  hc.isPrePerfectOrderWeekly(weekly),
    TECH_PRE_PERFECT_ORDER_MONTHLY: hc.isPrePerfectOrderMonthly(monthly),

    /* 逆パーフェクトオーダー前夜 */
    TECH_PRE_REVERSE_PERFECT_ORDER_DAILY:   hc.isPreReversePerfectOrderDaily(daily),
    TECH_PRE_REVERSE_PERFECT_ORDER_WEEKLY:  hc.isPreReversePerfectOrderWeekly(weekly),
    TECH_PRE_REVERSE_PERFECT_ORDER_MONTHLY: hc.isPreReversePerfectOrderMonthly(monthly),

    /* 移動平均線の収束 */
    TECH_MA_CONGESTION: hc.isMaCongestion(daily),

    /* 移動平均線の拡散 */
    TECH_MA_SPREAD: slope(
      hc.isMaSpreadUp(daily) === "up",
      hc.isMaSpreadUp(daily) === "down"
    ),

    /* 100MAトレンド */
    TECH_MA100_TREND: hc.isMa100Trend(daily),

    /* 下半身・逆下半身 */
    TECH_KAHANSHIN:       hc.isKahanshin(daily),
    TECH_GYAKU_KAHANSHIN: hc.isGyakuKahanshin(daily),

    /* 5MA更新 */
    TECH_5MA_UPDATE: slope(
      hc.is5MaHighUpdate(daily),
      hc.is5MaLowUpdate(daily)
    ),

    /* 酒田五法 */
    TECH_SAKATA_TRIPLE_TOP:    hc.isSakataTripleTop(daily)    ? 1 : null,
    TECH_SAKATA_TRIPLE_BOTTOM: hc.isSakataTripleBottom(daily) ? 1 : null,
    TECH_SAKATA_SANKU_UP:      hc.isSakataSankuUp(daily)      ? 1 : null,
    TECH_SAKATA_SANKU_DOWN:    hc.isSakataSankuDown(daily)    ? 1 : null,
    TECH_SAKATA_SANPEI_UP:     hc.isSakataSanpeiUp(daily)     ? 1 : null,
    TECH_SAKATA_SANPEI_DOWN:   hc.isSakataSanpeiDown(daily)   ? 1 : null,
    TECH_SAKATA_SANPO_UP:      hc.isSakataSanpoUp(daily)      ? 1 : null,
    TECH_SAKATA_SANPO_DOWN:    hc.isSakataSanpoDown(daily)    ? 1 : null,

    /* パターン */
    TECH_HEAD_AND_SHOULDERS: hc.isHeadAndShoulders(daily),
    TECH_DOUBLE_BOTTOM:      hc.isDoubleBottom(daily),
    TECH_NICHI_DAI:          hc.isNichiDai(daily),
    TECH_GYAKU_NICHI_DAI:    hc.isGyakuNichiDai(daily),
    TECH_IN_IN_HARAMI:       hc.isInInHarami(daily),
    TECH_RED_BLUE_CROSS:     hc.isRedBlueCross(daily, weekly, monthly),
    TECH_RETURN_SELL_END:    hc.isReturnSellEnd(daily),
    TECH_DOWN_TREND_END:     hc.isDownTrendEnd(daily),
    TECH_MOMIAI:             hc.isMomiai(daily),

    /* 物別れ */
    TECH_MONOWAKARE: mono(hc.isMonowakareUp(daily), hc.isMonowakareDown(daily)),
    TECH_MONOWAKARE_RED_BLUE_CROSS: mono(
      hc.isMonowakareRedBlueCrossUp(daily, weekly, monthly),
      hc.isMonowakareRedBlueCrossDown(daily, weekly, monthly)
    ),

    /* 9の法則 */
    TECH_RULE9_DAILY:  rule9Daily,
    TECH_RULE9_WEEKLY: rule9Weekly,

    /* BBゾーンブレイク */
    TECH_BB_ZONE_BREAK_DAILY:   hc.isBbZoneBreakDaily(daily),
    TECH_BB_ZONE_BREAK_WEEKLY:  hc.isBbZoneBreakWeekly(weekly),
    TECH_BB_ZONE_BREAK_MONTHLY: hc.isBbZoneBreakMonthly(monthly),

    /* ボックスレンジ */
    TECH_BOX_RANGE: hc.isBoxRange(daily),

    /* 過熱 */
    TECH_OVERHEAT: hc.isOverheat(daily),

    /* グランビル */
    TECH_GRANVILLE: granville,

    /* トレンドサイクル進行度：{ direction, count, startDate, lastDate } オブジェクトをそのまま格納 */
    TECH_CYCLE_PROGRESS: cycle ?? null,

    /* 節目 */
    TECH_FUSHIME_UP:   fushimeUp,
    TECH_FUSHIME_DOWN: fushimeDown
  };
}

/**
 * computeHeuristicsForDate() のフル計算（全銘柄 × runAllConditions()）を行う前に、
 * この対象日が実際に解決する日付（＝latestDateGlobal）を軽量に見積もる。
 *
 * dailyByCode内の有効な銘柄からサンプル（最大 PREDICT_SAMPLE_SIZE 件）だけを取り出し、
 * その中での最新日（最大値）を採用する。1銘柄だけで判定すると、その銘柄固有の
 * データ欠損（個別の取引停止等）により実際より古い日付に誤判定するリスクがあるため、
 * 複数銘柄のサンプルの最大値を取ることで、市場全体の休場日判定としての精度を確保する
 * （全銘柄は基本的に同一の取引所カレンダーに従うため、サンプル内の最大値が
 * 市場全体の実際の最新営業日と一致する可能性が高い）。
 *
 * @param {Map<string, object>} dailyByCode
 * @param {string} targetDate - YYYYMMDD
 * @returns {string|null}
 */
const PREDICT_SAMPLE_SIZE = 20;

function predictResolvedDate(dailyByCode, targetDate) {
  let best = null;
  let sampled = 0;

  for (const rawDaily of dailyByCode.values()) {
    if (!rawDaily || rawDaily.error) continue;

    const sliced = sliceDailyUpTo(rawDaily, targetDate);
    const keys = Object.keys(sliced);
    if (keys.length === 0) continue;

    const latest = keys.sort().pop();
    if (!best || latest > best) best = latest;

    sampled++;
    if (sampled >= PREDICT_SAMPLE_SIZE) break;
  }

  return best;
}

/* ==========================================================================================
   4. 1日分の heuristics を生成する（純粋な計算のみ。ネットワークアクセスは行わない）

      dailyByCode は fetchAllSymbolsDaily() であらかじめ取得済みのものを渡す
      （2026-07、日足取得と条件計算を分離した。詳細は 2.5 を参照）。

      targetDate が null の場合は通常モード（取得した日足データをそのまま使い、
      最新日付をデータから自動判定する）。
      targetDate が YYYYMMDD の場合は、指定日/期間モード向けに、その日以前の
      日足のみへスライスしてから週足・月足を集計する（期間モードで1回だけ取得した
      長期間の日足を対象日ごとに使い回す際、対象日より未来のデータが混入
      〔先読み〕しないようにするため）。

      休場日など有効データが取得できない場合は null を返す。
========================================================================================== */

/**
 * @param {Map<string, object>} dailyByCode - fetchAllSymbolsDaily() の戻り値
 * @param {string|null} targetDate - YYYYMMDD または null
 * @returns {string|null} - 生成した heuristics の日付（YYYYMMDD）、スキップ時は null
 */
function computeHeuristicsForDate(dailyByCode, targetDate) {
  let finalData = {};
  let latestDateGlobal = null;
  let okCount = 0, fetchErrorCount = 0, insufficientCount = 0;

  const needDaily   = 100; // Rule9 daily
  const needWeekly  = 100; // Rule9 weekly
  const needMonthly = 75;  // MA75, PO, RPO, etc.

  for (const code of symbols) {
    const rawDaily = dailyByCode.get(code);

    // --- データ不足チェック（fetchAllSymbolsDaily の error を検出） ---
    if (!rawDaily || rawDaily.error) {
      finalData[code] = { error: rawDaily?.error ?? "no data" };
      fetchErrorCount++;
      continue;
    }

    // targetDateが指定されている場合、それ以前の日足のみに絞ってから週足・月足を集計する
    const daily = targetDate ? sliceDailyUpTo(rawDaily, targetDate) : rawDaily;
    const weekly = resampleWeekly(daily);
    const monthly = resampleMonthly(daily);

    // --- ローソク足が少なすぎる場合もスキップ ---
    const dailyCount   = Object.keys(daily).length;
    const weeklyCount  = Object.keys(weekly).length;
    const monthlyCount = Object.keys(monthly).length;

    const insufficient =
      dailyCount < needDaily || weeklyCount < needWeekly || monthlyCount < needMonthly;

    if (insufficient) {
      finalData[code] = { error: "insufficient candles" };
      insufficientCount++;
      continue;
    }

    // 最新日付を更新
    const latestDate = Object.keys(daily).sort().pop();
    if (!latestDateGlobal || latestDate > latestDateGlobal) {
      latestDateGlobal = latestDate;
    }

    finalData[code] = runAllConditions(daily, weekly, monthly);
    okCount++;
  }

  // 全銘柄がスキップされた場合（休場日など有効データが存在しない）
  if (!latestDateGlobal) {
    console.log(`WARN: ${targetDate ?? "（通常モード）"} は有効なデータが取得できませんでした（休場日の可能性）。スキップします。`);
    return null;
  }

  /* 保存先フォルダ（data/heuristics/YYYYMM）を作成 */
  const yyyymm = latestDateGlobal.slice(0, 6);
  const heuristicsDir = `data/heuristics/${yyyymm}`;
  if (!fs.existsSync(heuristicsDir)) fs.mkdirSync(heuristicsDir, { recursive: true });

  /* heuristics_YYYYMMDD.json を保存 */
  const outFile = `${heuristicsDir}/heuristics_${latestDateGlobal}.json`;
  fs.writeFileSync(outFile, JSON.stringify(finalData, null, 2));

  /* バックアップ処理（data/backup/heuristics_YYYYMMDD.json.TIMESTAMP） */
  // タイムスタンプ生成・コピー・件数ベースの古いバックアップ削除は
  // scripts/lib/jst_time.js・scripts/lib/backup_utils.js へ共通化した（2026-07）。
  const backupDir = "data/backup";
  createBackup(outFile, backupDir);

  /* バックアップ最新 8 件だけ残す */
  pruneKeepNewest(backupDir, f => f.startsWith("heuristics_") && f.includes(".json."), 8);

  console.log(
    `heuristics_${latestDateGlobal}.json generation completed. `
    + `(成功: ${okCount} / 取得エラー: ${fetchErrorCount} / データ不足: ${insufficientCount})`
  );
  return latestDateGlobal;
}

/* ==========================================================================================
   5. 期間モード用：fromDate〜toDate の営業日候補を生成する
      土日は事前に除外する。祝日は computeHeuristicsForDate の結果（有効データなし）で自動スキップされる。
========================================================================================== */

/**
 * @param {string} fromDate - YYYYMMDD
 * @param {string} toDate   - YYYYMMDD
 * @returns {string[]} - 土日を除いた日付の YYYYMMDD 配列
 */
function generateBusinessDayCandidates(fromDate, toDate) {
  const candidates = [];
  const cur = new Date(
    Date.UTC(
      parseInt(fromDate.slice(0, 4), 10),
      parseInt(fromDate.slice(4, 6), 10) - 1,
      parseInt(fromDate.slice(6, 8), 10)
    )
  );
  const end = new Date(
    Date.UTC(
      parseInt(toDate.slice(0, 4), 10),
      parseInt(toDate.slice(4, 6), 10) - 1,
      parseInt(toDate.slice(6, 8), 10)
    )
  );

  while (cur <= end) {
    const dow = cur.getUTCDay(); // 0=日, 6=土
    if (dow !== 0 && dow !== 6) {
      const y = cur.getUTCFullYear();
      const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
      const d = String(cur.getUTCDate()).padStart(2, "0");
      candidates.push(`${y}${m}${d}`);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return candidates;
}

/* ==========================================================================================
   5.5 期間モード用：1日分の heuristics 生成完了ごとに commit & push する
       range モードは全期間の完了を待たずに、日付単位で反映する。
       push 失敗時は fetch → rebase -X theirs → push でリトライする
       （.github/workflows/heuristics.yml の最終コミットステップと同一方針）。
       git の user.name / user.email は Actions 側（.yml）で事前設定済みであることが前提。
========================================================================================== */

/**
 * @param {string} targetDate - computeHeuristicsForDate が返した YYYYMMDD（生成済みファイルの日付）
 * @returns {void}
 */
function commitAndPushDate(targetDate) {
  const run = (cmd) => execSync(cmd, { stdio: "inherit" });

  try {
    // 新規・更新・削除（バックアップ世代整理分の削除も含む）をまとめてステージング
    run("git add -A -- data/heuristics data/backup");

    // ステージ済み差分の有無を確認（差分なしならコミットしない）
    let hasChanges = true;
    try {
      execSync("git diff --cached --quiet");
      hasChanges = false; // 差分なし
    } catch {
      hasChanges = true; // 差分あり
    }

    if (!hasChanges) {
      console.log(`[git] ${targetDate}: コミット対象の差分がないためスキップします。`);
      return;
    }

    run(`git commit -m "Update heuristics_${targetDate}.json and backup"`);

    try {
      run("git push origin main");
    } catch {
      console.log(`[git] ${targetDate}: push が拒否されました。最新の main を取得してリベースします。`);
      run("git fetch origin");
      run("git rebase -X theirs origin/main");
      run("git push origin main");
    }

    console.log(`[git] ${targetDate}: commit & push 完了。`);
  } catch (err) {
    // 1日分の commit/push に失敗しても、後続日付の処理は継続する
    console.log(`ERROR: ${targetDate} の commit/push に失敗しました。`, err.message);
  }
}

/* ==========================================================================================
   6. エントリポイント
========================================================================================== */

async function main() {
  if (RUN_MODE === "single") {
    // --- 単一日指定モード ---
    console.log("日足取得中...");
    const dailyByCode = await fetchAllSymbolsDaily(singleDate);
    computeHeuristicsForDate(dailyByCode, singleDate);

  } else if (RUN_MODE === "range") {
    // --- 期間指定モード ---
    // 土日を事前除外した候補日列を生成（祝日は computeHeuristicsForDate 側で
    // 有効データなしとして自動スキップ）
    const candidates = generateBusinessDayCandidates(fromDate, toDate);
    console.log(`期間内候補日（土日除外済み）: ${candidates.length} 日`);

    // 2026-07: 範囲全体で必要となる日足を銘柄ごとに1回だけ取得し、対象日ごとに使い回す。
    // period2=toDate（範囲内で最も未来の対象日）、period1の基準日=fromDate（範囲内で最も古い
    // 対象日）とすることで、range内のどの対象日についても、その日自身が必要とする
    // DAILY_LOOKBACK_DAYS分の遡及期間を確保できる（toDateだけを基準にすると、
    // fromDate〜toDateの日数分だけfromDate側の遡及期間が不足するため。2026-07 修正）。
    console.log("範囲全体の日足を一括取得中（この処理は1回だけ実行されます）...");
    const dailyByCode = await fetchAllSymbolsDaily(toDate, fromDate);

    // 2026-07 追加: 休場日の候補（例: 年末年始・GW等）は、スライス後の最新日が
    // 直近の実際の営業日へ解決される（＝今回の実行で既に生成済みの日付と同じ）ため、
    // computeHeuristicsForDate() をフルに実行しても最終的には無コミットで捨てられる。
    // 4,400銘柄分のrunAllConditions()（1日あたり数分規模）を毎回無駄にしないよう、
    // 代表銘柄のサンプルだけで「この候補が解決する日付」を軽量に事前判定し、
    // 今回の実行で既に生成済みの日付と一致する場合はフル計算をスキップする。
    const producedDatesThisRun = new Set();

    for (const date of candidates) {
      console.log(`\n=== 処理中: ${date} ===`);

      const predicted = predictResolvedDate(dailyByCode, date);
      if (predicted && producedDatesThisRun.has(predicted)) {
        console.log(`  → ${date} は直近の営業日（${predicted}）と同一と推定されるためスキップします（休場日の可能性）。`);
        continue;
      }

      const result = computeHeuristicsForDate(dailyByCode, date);
      if (!result) {
        console.log(`  → ${date} はスキップされました（休場日またはデータなし）`);
      } else {
        producedDatesThisRun.add(result);
        // 全期間の完了を待たず、1日分できるたびに commit & push する
        commitAndPushDate(result);
      }
      // computeHeuristicsForDate はネットワークアクセスを行わない（日足は取得済み）ため、
      // 旧実装にあった「日付間のAPI負荷軽減のための待機」は不要になった。
    }

  } else {
    // --- 通常モード（引数なし、既存動作を維持） ---
    const dailyByCode = await fetchAllSymbolsDaily(null);
    computeHeuristicsForDate(dailyByCode, null);
  }
}

main();
