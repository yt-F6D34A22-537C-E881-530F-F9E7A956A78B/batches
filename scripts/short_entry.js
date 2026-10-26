/********************************************************************************************
 * short_entry.js — short_entry_YYYYMMDD.json 生成（空売りエントリー検出）
 *
 * data/ohlcv/（fetch.js が生成する日次OHLCVアーカイブ）のローカルファイルのみを読み、
 * 外部通信は行わない。検出ロジックは scripts/lib/short_entry_conditions.js を参照。
 ********************************************************************************************/

import fs from "fs";
import { SHORT_ENTRY_PARAMS as P, buildSeries, detectShortEntry } from "./lib/short_entry_conditions.js";

/* ==========================================================================================
   0. コマンドライン引数のパース
      --date  YYYYMMDD   : 単一日指定（その日を判定日とする）
      --from  YYYYMMDD   : 期間指定・開始日（--to とペアで使用）
      --to    YYYYMMDD   : 期間指定・終了日（--from とペアで使用）
      引数なし           : 通常モード（ohlcv アーカイブの最新日を判定日とする）
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

// --- 引数バリデーション（heuristics.js と同一） ---
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
   1. ohlcv アーカイブの日付一覧（data/ohlcv/YYYYMM/ohlcv_YYYYMMDD.json）
========================================================================================== */

const OHLCV_DIR = "data/ohlcv";
const OUT_DIR = "data/short_entry";

/** @returns {string[]} 昇順（古い日付が先頭）の YYYYMMDD 配列 */
function listOhlcvDates() {
  const dates = [];
  for (const ym of fs.readdirSync(OHLCV_DIR)) {
    if (!/^\d{6}$/.test(ym)) continue;
    for (const f of fs.readdirSync(`${OHLCV_DIR}/${ym}`)) {
      const m = /^ohlcv_(\d{8})\.json$/.exec(f);
      if (m) dates.push(m[1]);
    }
  }
  return dates.sort();
}

/* ==========================================================================================
   2. 判定日（targets）の決定
      判定には、判定日から遡って NEED_BARS 本の営業日の履歴が必要。
      履歴不足の日付は「検出0件」と区別できなくなるため、ファイルを生成せずスキップする。
========================================================================================== */

const NEED_BARS = P.headLookbackBars + P.baseBars + P.spikeBars + P.maPeriod;

function resolveTargets(allDates) {
  let picked;
  if (RUN_MODE === "single") {
    picked = allDates.filter(d => d === singleDate);
    if (picked.length === 0) {
      console.log(`WARN: ${singleDate} は ohlcv アーカイブに存在しません（休場日の可能性）。スキップします。`);
    }
  } else if (RUN_MODE === "range") {
    picked = allDates.filter(d => d >= fromDate && d <= toDate);   // 休場日はアーカイブに無いため自然に除外される
  } else {
    picked = allDates.slice(-1);
  }

  return picked.filter(d => {
    if (allDates.indexOf(d) >= NEED_BARS) return true;
    console.log(`WARN: ${d} は履歴が不足しています（${NEED_BARS} 営業日分が必要）。スキップします。`);
    return false;
  });
}

/* ==========================================================================================
   3. 判定日ごとの検出と保存
========================================================================================== */

function main() {
  const allDates = listOhlcvDates();
  if (allDates.length === 0) {
    console.log("ERROR: ohlcv アーカイブが見つかりません（data/ohlcv/）。");
    process.exit(1);
  }

  const targets = resolveTargets(allDates);
  if (targets.length === 0) {
    console.log("WARN: 判定対象の日付がありません。終了します。");
    return;
  }

  // 読み込む範囲：最古の判定日から NEED_BARS 本遡った日〜最新の判定日
  const loadFrom = allDates.indexOf(targets[0]) - NEED_BARS;
  const loadDates = allDates.slice(loadFrom, allDates.indexOf(targets[targets.length - 1]) + 1);
  const n = loadDates.length;
  console.log(`ohlcv 読み込み: ${loadDates[0]} ～ ${loadDates[n - 1]}（${n} 営業日）`);

  // 銘柄ごとの系列（欠損は NaN。検出側で欠損を含む窓を除外する）
  const bySymbol = new Map();
  loadDates.forEach((d, k) => {
    const day = JSON.parse(fs.readFileSync(`${OHLCV_DIR}/${d.slice(0, 6)}/ohlcv_${d}.json`, "utf8"));
    for (const [code, row] of Object.entries(day)) {
      if (!row || row.error) continue;
      let s = bySymbol.get(code);
      if (!s) {
        s = {
          h: new Float64Array(n).fill(NaN), l: new Float64Array(n).fill(NaN),
          c: new Float64Array(n).fill(NaN), v: new Float64Array(n).fill(NaN),
        };
        bySymbol.set(code, s);
      }
      s.h[k] = row.h ?? NaN; s.l[k] = row.l ?? NaN; s.c[k] = row.c ?? NaN; s.v[k] = row.v ?? NaN;
    }
  });

  const idxOf = new Map(targets.map(d => [d, loadDates.indexOf(d)]));
  const resultsByDate = new Map(targets.map(d => [d, {}]));

  for (const [code, raw] of [...bySymbol].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const series = buildSeries(raw);
    for (const d of targets) {
      const res = detectShortEntry(series, idxOf.get(d));
      if (!res) continue;
      const { headIdx, lowIdx, ...out } = res;
      resultsByDate.get(d)[code] = { ...out, headDate: loadDates[headIdx], lowDate: loadDates[lowIdx] };
    }
  }

  for (const [d, data] of resultsByDate) {
    const vals = Object.values(data);
    const meta = {
      target_date: d,
      params: P,
      scanned: bySymbol.size,
      counts: {
        entry: vals.filter(x => x.stage === "entry").length,
        watch: vals.filter(x => x.stage === "watch").length,
      },
    };

    const outDir = `${OUT_DIR}/${d.slice(0, 6)}`;
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // タイムスタンプは含めない（同一入力なら同一内容 → 再実行しても差分が出ずコミットされない）。
    // ohlcv から決定的に再生成できる派生データのため、heuristics と異なりバックアップは取らない。
    fs.writeFileSync(`${outDir}/short_entry_${d}.json`, JSON.stringify({ meta, data }, null, 2));
    console.log(`short_entry_${d}.json generation completed. (entry: ${meta.counts.entry} / watch: ${meta.counts.watch} / 走査銘柄: ${meta.scanned})`);
  }
}

main();
