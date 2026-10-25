// scripts/fetch_ohlcv_backfill.js
//
// 責務: data/ohlcv/ に既にある最古のアーカイブより「過去側」の日足OHLCVを、
//       新しい日付 → 古い日付の順（最新から）に、1回の実行につき1ウィンドウぶん遡及取得し、
//       data/ohlcv/YYYYMM/ohlcv_YYYYMMDD.json として日付ごとに恒久保存する。
//
// 設計方針:
//   - scripts/fetch.js（日次更新・本番稼働中）には手を入れない。fetch.js の range={N}d 指定は
//     「実行日から遡る日数」であり、過去の任意区間を指定できないため、
//     v8/finance/chart の period1/period2（UNIX秒）で区間を明示する別エントリーポイントとした。
//     ※ period1/period2 も Yahoo 非公式APIの挙動（conventions.yahooFinanceApiFamilies と同じ前提）。
//   - 再開点は「BACKFILL_CEILING 以前で、最古の妥当なアーカイブ日付の前日」。
//     data/ohlcv/ をローカル走査するのみで、GitHub API は呼ばない（heuristics_backfill_trigger.js と同じ方針）。
//   - 一度書いたファイルは不変（fetch.js の「当日以外は上書きしない」方針と同じ）。
//     そのため取得失敗が一定割合を超えた場合は、1ファイルも書かずに異常終了する
//     （欠損銘柄を含んだ不完全なファイルが恒久化されるのを防ぐ）。
//   - 営業日判定は行わない。Yahoo が返した日付キーをそのまま採用する。
//   - 出力形式・値の扱いは fetch.js（v8/finance/chart 経路）と同一にする。
//     銘柄コード直下に {o,h,l,c,v}、JSON.stringify(..., null, 2)。Yahoo が返した o/h/l/c/v が
//     null の足も、fetch.js と同様にフィルタせずそのまま null で書き込む（独自の欠損除外は行わない）。
//   - どこまで遡るかは BACKFILL_FLOOR（既定: 19710101＝実質的に制限なし）で打ち切れる。
//     通常は「代表銘柄にデータが存在しないウィンドウ」に到達した時点で自動的に終了する。

import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import xlsx from "xlsx";

// -----------------------------
// 0. 設定（環境変数。未指定時は既定値）
// -----------------------------
const OHLCV_DIR = "data/ohlcv";
const REQUEST_INTERVAL_MS = 500;   // fetch.js の fetchViaV8ChartAll と同じ間隔
const MAX_ATTEMPTS = 3;            // 1銘柄あたりの最大試行回数（一時的な失敗のみ再試行）
const MAX_FAILED_RATIO = 0.05;     // 一時的な失敗の許容割合。超えたら何も書かず異常終了する
// これ未満の銘柄数しか持たないファイルは「再開点」の判定から除外する。
// 古い年代ほど Yahoo が保持する銘柄数が少ないため、閾値は小さく保つ（偶発的な1〜数銘柄だけのファイルの除外が目的）
const MIN_SYMBOLS_PER_ARCHIVE = 10;
// 「そのウィンドウに株価データが存在するか」の事前確認用（長期間上場している大型株）
const PROBE_CODES = ["7203", "6758", "9984"];

function readYmdEnv(name, fallback) {
  const raw = process.env[name] || fallback;
  if (!/^\d{8}$/.test(raw)) {
    console.error(`ERROR: ${name} must be YYYYMMDD. Got: "${raw}"`);
    process.exit(1);
  }
  return raw;
}

// この日付「以前」を遡及対象とする（2023/06/08 以降は収集済みのため 20230607）
const BACKFILL_CEILING = readYmdEnv("BACKFILL_CEILING", "20230607");
// この日付より古い側は取得しない。取得できる限り遡る運用のため、実質的に制限しない既定値とする
// （period1 が負数にならないよう 1971-01-01 を下限とした）。
const BACKFILL_FLOOR = readYmdEnv("BACKFILL_FLOOR", "19710101");

const WINDOW_DAYS = (() => {
  const raw = process.env.BACKFILL_WINDOW_DAYS || "90";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 366) {
    console.error(`ERROR: BACKFILL_WINDOW_DAYS must be an integer between 1 and 366. Got: "${raw}"`);
    process.exit(1);
  }
  return n;
})();

// -----------------------------
// 1. 日付ユーティリティ（'YYYYMMDD' 文字列 ⇔ UTC日付）
// -----------------------------
function ymdToUtcMs(ymd) {
  return Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
}

function utcMsToYmd(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function addDays(ymd, days) {
  return utcMsToYmd(ymdToUtcMs(ymd) + days * 86400000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -----------------------------
// 2. 銘柄コードの読み込み（fetch.js と同一ロジック）
// -----------------------------
function readSymbols() {
  const workbook = xlsx.readFile("data/data_j.xlsx");
  const sheet = workbook.Sheets["Sheet1"];
  const rows = xlsx.utils.sheet_to_json(sheet);

  const symbols = rows
    .map((r) => String(r["コード"]).trim())
    .filter((code) => code && code !== "undefined");

  if (symbols.length === 0) {
    console.error("ERROR: Excel から銘柄コードが読み取れませんでした。");
    process.exit(1);
  }
  return symbols;
}

// -----------------------------
// 3. 再開点の決定（data/ohlcv/ のローカル走査。API呼び出しなし）
// -----------------------------
function archivePath(date) {
  return path.join(OHLCV_DIR, date.slice(0, 6), `ohlcv_${date}.json`);
}

// BACKFILL_CEILING 以前の既存アーカイブ日付を昇順で返す
function listArchivedDatesUpToCeiling() {
  const dates = [];
  if (!fs.existsSync(OHLCV_DIR)) return dates;

  for (const monthDir of fs.readdirSync(OHLCV_DIR)) {
    const monthPath = path.join(OHLCV_DIR, monthDir);
    if (!fs.statSync(monthPath).isDirectory()) continue;

    for (const file of fs.readdirSync(monthPath)) {
      const matched = file.match(/^ohlcv_(\d{8})\.json$/);
      if (matched && matched[1] <= BACKFILL_CEILING) dates.push(matched[1]);
    }
  }
  return dates.sort();
}

// 一部銘柄だけを含む不完全なファイル（過去にv7経路の不具合で発生した前例あり）が
// 再開点を誤って古い側へ引きずらないよう、銘柄数が十分あるファイルだけを「妥当」とみなす
function isPlausibleArchive(date) {
  try {
    const json = JSON.parse(fs.readFileSync(archivePath(date), "utf8"));
    return Object.keys(json).length >= MIN_SYMBOLS_PER_ARCHIVE;
  } catch {
    return false;
  }
}

function findOldestPlausibleArchiveDate() {
  for (const date of listArchivedDatesUpToCeiling()) {
    if (isPlausibleArchive(date)) return date;
  }
  return null;
}

// -----------------------------
// 4. Yahoo Finance（v8/finance/chart・期間指定）
// -----------------------------
// 戻り値: { kind: "ok", bars } | { kind: "nodata", reason } | { kind: "transient", reason }
//   nodata    … その期間に株価が存在しない（その期間はまだ未上場の銘柄など）。失敗ではない。
//               Yahoo は「期間内にデータが無い」場合、HTTP 200 で timestamp なしを返すほか、
//               HTTP 400/404 と chart.error（code は "Not Found" に限らない）を返すことがあるため、
//               どちらも nodata として扱う（再試行しない）。
//   transient … 通信エラー・429・5xx・JSON として解釈できない応答など、再試行で改善しうる失敗。
//               失敗割合の判定対象
async function fetchSymbolRange(code, windowStart, windowEnd) {
  // 取りこぼし防止のため前後1日の余白を取り、後段で日付キーにより厳密に絞り込む
  const period1 = Math.floor(ymdToUtcMs(addDays(windowStart, -1)) / 1000);
  const period2 = Math.floor(ymdToUtcMs(addDays(windowEnd, 2)) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?interval=1d&period1=${period1}&period2=${period2}`;

  let lastReason = "unknown";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);

      let json;
      try {
        json = await res.json();
      } catch {
        throw new Error(`HTTP ${res.status} (non-JSON response)`);
      }

      const result = json.chart?.result?.[0];
      if (!result) {
        const err = json.chart?.error;
        // 期間内にデータが無い銘柄（その期間はまだ未上場など）への応答。2026-10 修正：
        // 従来は code === "Not Found" のみを nodata とし、それ以外の chart.error を一時的な失敗として
        // 3回再試行していたため、未上場期間の銘柄が大量に transient 扱いになり失敗率判定で異常終了した。
        if (err && (err.code === "Not Found" || res.status === 400 || res.status === 404)) {
          return { kind: "nodata", reason: `HTTP ${res.status} ${err.code ?? ""}: ${err.description ?? ""}`.trim() };
        }
        throw new Error(err?.description || `HTTP ${res.status}: no chart result`);
      }

      const timestamps = result.timestamp;
      if (!timestamps || timestamps.length === 0) return { kind: "nodata", reason: "empty timestamp" };

      const q = result.indicators.quote[0];
      const bars = {};
      for (let i = 0; i < timestamps.length; i++) {
        // 日付キーの導出は fetch.js の fetchSymbol() と同一（実行環境のローカルTZ依存。Actions は UTC）
        const date = new Date(timestamps[i] * 1000);
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        const key = `${y}${m}${d}`;
        if (key < windowStart || key > windowEnd) continue;

        // fetch.js の fetchSymbol() と同一（null の足もフィルタせずそのまま保持する）
        bars[key] = {
          o: q.open[i],
          h: q.high[i],
          l: q.low[i],
          c: q.close[i],
          v: q.volume[i]
        };
      }
      return { kind: "ok", bars };
    } catch (err) {
      lastReason = err.message;
      if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
    }
  }
  return { kind: "transient", reason: lastReason };
}

// -----------------------------
// 5. メイン
// -----------------------------
async function main() {
  const oldest = findOldestPlausibleArchiveDate();
  const windowEnd = oldest ? addDays(oldest, -1) : BACKFILL_CEILING;

  if (windowEnd < BACKFILL_FLOOR) {
    console.log(`Backfill already completed (next end ${windowEnd} < floor ${BACKFILL_FLOOR}).`);
    return;
  }
  const windowStart = (() => {
    const start = addDays(windowEnd, -(WINDOW_DAYS - 1));
    return start < BACKFILL_FLOOR ? BACKFILL_FLOOR : start;
  })();
  console.log(`Backfill window (newest first): ${windowStart} - ${windowEnd} (oldest archive: ${oldest ?? "none"})`);

  // 5-1. 事前確認: 代表銘柄のいずれにもデータが無いウィンドウは「過去データの終端」とみなし、全銘柄走査を省く
  const probeResults = [];
  for (const code of PROBE_CODES) {
    probeResults.push(await fetchSymbolRange(code, windowStart, windowEnd));
    await sleep(REQUEST_INTERVAL_MS);
  }
  if (probeResults.every((r) => r.kind === "nodata" || (r.kind === "ok" && Object.keys(r.bars).length === 0))) {
    // nodata の判定を広げたため、リクエスト形式の不備などで「全て nodata」になっても
    // 正常終了（＝完了）と誤認しないよう、直近期間で同じ銘柄が取得できることを対照として確認する
    const controlEnd = utcMsToYmd(Date.now());
    const control = await fetchSymbolRange(PROBE_CODES[0], addDays(controlEnd, -30), controlEnd);
    if (control.kind !== "ok" || Object.keys(control.bars).length === 0) {
      console.error(`ERROR: control request (${PROBE_CODES[0]}, last 30 days) returned ${control.kind}: ${control.reason ?? ""}. The API call itself may be failing.`);
      process.exit(1);
    }
    console.log(`No data for probe symbols in this window (${probeResults.map((r) => r.reason ?? r.kind).join(" | ")}). Treating as the end of available history.`);
    return;
  }

  // 5-2. 全銘柄を順次取得（1銘柄＝ウィンドウ全体を1リクエスト）
  const symbols = readSymbols();
  const dataByCode = {};
  const nodataReasons = new Map();   // nodata の理由別件数（診断ログ用）
  let transientFailed = new Map();   // code → 失敗理由

  for (const code of symbols) {
    const r = await fetchSymbolRange(code, windowStart, windowEnd);
    if (r.kind === "ok") dataByCode[code] = r.bars;
    else if (r.kind === "nodata") nodataReasons.set(r.reason, (nodataReasons.get(r.reason) ?? 0) + 1);
    else transientFailed.set(code, r.reason);
    await sleep(REQUEST_INTERVAL_MS);
  }

  // 一時的な失敗のみ、少し待ってからもう1周だけ再試行する
  if (transientFailed.size > 0) {
    console.log(`Retrying ${transientFailed.size} transient failures after 30s...`);
    await sleep(30000);
    const stillFailed = new Map();
    for (const code of transientFailed.keys()) {
      const r = await fetchSymbolRange(code, windowStart, windowEnd);
      if (r.kind === "ok") dataByCode[code] = r.bars;
      else if (r.kind === "nodata") nodataReasons.set(r.reason, (nodataReasons.get(r.reason) ?? 0) + 1);
      else stillFailed.set(code, r.reason);
      await sleep(REQUEST_INTERVAL_MS);
    }
    transientFailed = stillFailed;
  }

  const nodataCount = [...nodataReasons.values()].reduce((a, b) => a + b, 0);
  const failedRatio = transientFailed.size / symbols.length;
  console.log(`Fetched: ok=${Object.keys(dataByCode).length}, nodata=${nodataCount}, transient failures=${transientFailed.size} (${(failedRatio * 100).toFixed(2)}%) of ${symbols.length} symbols`);
  // 原因調査用：理由別件数と失敗銘柄のサンプルを出力する
  for (const [reason, n] of nodataReasons) console.log(`  nodata   x${n}: ${reason}`);
  const transientReasons = new Map();
  for (const reason of transientFailed.values()) transientReasons.set(reason, (transientReasons.get(reason) ?? 0) + 1);
  for (const [reason, n] of transientReasons) console.log(`  transient x${n}: ${reason}`);
  if (transientFailed.size > 0) console.log(`  transient sample codes: ${[...transientFailed.keys()].slice(0, 20).join(", ")}`);
  if (failedRatio > MAX_FAILED_RATIO) {
    console.error(`ERROR: transient failure ratio exceeds ${MAX_FAILED_RATIO * 100}%. Nothing was written.`);
    process.exit(1);
  }

  // 5-3. コード軸 → 日付軸へ転置（銘柄の並びは data_j.xlsx の順に揃える）
  const byDate = {};
  for (const code of symbols) {
    const bars = dataByCode[code];
    if (!bars) continue;
    for (const [date, bar] of Object.entries(bars)) {
      byDate[date] ??= {};
      byDate[date][code] = bar;
    }
  }

  const dates = Object.keys(byDate).sort().reverse(); // 新しい日付から書き込む
  if (dates.length === 0) {
    console.error("ERROR: 有効なOHLCVデータを1件も取得できませんでした。書き込みをスキップします。");
    process.exit(1);
  }

  // 5-4. 日付ごとのファイルとして書き出す（既存ファイルは不変のため上書きしない）
  for (const date of dates) {
    const filePath = archivePath(date);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      console.log(`skip (archived, immutable): ${filePath}`);
      continue;
    }
    fs.writeFileSync(filePath, JSON.stringify(byDate[date], null, 2));
    console.log(`saved: ${filePath} (${Object.keys(byDate[date]).length} symbols)`);
  }
}

main();
