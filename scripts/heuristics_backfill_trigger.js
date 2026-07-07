// scripts/heuristics_backfill_trigger.js
//
// 責務: data/heuristics/ 配下（actions/checkout 済みのローカルファイル）を走査し、
//       2025-07-01〜2026-06-30 の範囲で「次に処理を再開すべき from_date」を1件だけ決定する。
//
// 設計方針:
//   - 営業日判定は行わない。heuristics.yml の range モード（from_date/to_date）が
//     既存仕様として営業日判定を内包しているため、本スクリプトはそこに委譲する。
//   - API 呼び出しは一切行わない。actions/checkout 済みのファイルをローカルで
//     走査するのみのため、GitHub API のレート制限を考慮する必要がない
//     （/heuristics_dates が使う tree API 呼び出しすら不要）。
//   - 「進捗の再開点」は、既存の heuristics_YYYYMMDD.json のうち対象範囲内の
//     最新日付の"翌日"とする（単純な連続処理の再開であり、歯抜け探索は行わない。
//     歯抜けが発生する運用＝手動での特定日再実行等が生じた場合は、本ロジックの
//     対象外として別途手動対応する想定）。

const fs = require('fs');
const path = require('path');

const BACKFILL_START = process.env.BACKFILL_START; // 'YYYYMMDD'
const BACKFILL_END = process.env.BACKFILL_END;     // 'YYYYMMDD'
const HEURISTICS_DIR = path.join('data', 'heuristics');

function writeOutput(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

// data/heuristics/YYYYMM/heuristics_YYYYMMDD.json を走査し、
// 対象範囲内の既存日付（文字列 'YYYYMMDD'）の配列を昇順で返す
function listExistingDatesInRange(dir, start, end) {
  const dates = [];
  if (!fs.existsSync(dir)) return dates;

  for (const monthDir of fs.readdirSync(dir)) {
    const monthPath = path.join(dir, monthDir);
    if (!fs.statSync(monthPath).isDirectory()) continue;

    for (const file of fs.readdirSync(monthPath)) {
      const matched = file.match(/^heuristics_(\d{8})\.json$/);
      if (matched && matched[1] >= start && matched[1] <= end) {
        dates.push(matched[1]);
      }
    }
  }
  return dates.sort();
}

// 'YYYYMMDD' 文字列に1日加算した 'YYYYMMDD' を返す
function addOneDay(yyyymmdd) {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6)) - 1;
  const d = Number(yyyymmdd.slice(6, 8));
  const next = new Date(Date.UTC(y, m, d + 1));
  const pad = (n) => String(n).padStart(2, '0');
  return `${next.getUTCFullYear()}${pad(next.getUTCMonth() + 1)}${pad(next.getUTCDate())}`;
}

function main() {
  const existing = listExistingDatesInRange(HEURISTICS_DIR, BACKFILL_START, BACKFILL_END);

  const fromDate = existing.length === 0
    ? BACKFILL_START
    : addOneDay(existing[existing.length - 1]);

  if (fromDate > BACKFILL_END) {
    console.log('Backfill already completed for the target range.');
    writeOutput('from_date', '');
    return;
  }

  console.log(`Resuming backfill from: ${fromDate} to ${BACKFILL_END}`);
  writeOutput('from_date', fromDate);
}

main();
