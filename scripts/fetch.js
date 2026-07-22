import fetch from "node-fetch";
import fs from "fs";
import xlsx from "xlsx";
import path from "path";

// -----------------------------
// 0. 取得日数（起動パラメータ由来。未指定時は1＝直近1日分のみ）
// -----------------------------
// MAX_FETCH_DAYS は .github/workflows/fetch.yml の検証ステップと同一の値を渡す想定だが、
// fetch.js を直接ローカル実行した場合にも同じ上限を適用するための二重防御として
// ここでも既定値 3650（Yahoo Finance が公式にサポートする range 列挙の最大クラス「10y」に
// 相当する日数。range パラメータへの任意の "Nd" 指定自体は非公式な挙動のため、
// 公式にサポートされていると確認できる最大の粒度に合わせた安全側の上限としている）を持つ。
const MAX_FETCH_DAYS = Number(process.env.MAX_FETCH_DAYS || 3650);
const FETCH_DAYS = (() => {
  const raw = process.env.FETCH_DAYS || "1";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_FETCH_DAYS) {
    console.error(`ERROR: FETCH_DAYS must be an integer between 1 and ${MAX_FETCH_DAYS}. Got: "${raw}"`);
    process.exit(1);
  }
  return n;
})();

// -----------------------------
// 1. Excel から銘柄コードを読み込む（純コードのまま）
// -----------------------------
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

// -----------------------------
// 2. Yahoo Finance API（FETCH_DAYS 日分取得）
// -----------------------------
async function fetchSymbol(code) {
  const symbol = `${code}.T`;  // ← Yahoo API 用に .T を付ける
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${FETCH_DAYS}d`;

  try {
    const res = await fetch(url);
    const json = await res.json();

    if (!json.chart || !json.chart.result) {
      return {
        error: json.chart?.error?.description || "Unknown error from Yahoo Finance"
      };
    }

    const item = json.chart.result[0];
    const timestamps = item.timestamp;
    const q = item.indicators.quote[0];

    if (!timestamps || timestamps.length === 0) {
      return { error: "Not enough historical data" };
    }

    // YYYYMMDD → OHLCV
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

// -----------------------------
// 3. コード軸 → 日付軸への転置
// -----------------------------
// series が { error: "..." } 形式（取得失敗）の銘柄は、日付キーを持たないため
// そのまま Object.entries(series) をループすると "error" という文字列が
// 日付として byDate に混入してしまう。従来の data.json 方式でもこの銘柄は
// entry.keys() を .isdigit() でフィルタされることで実質的に無視されていたため、
// ここで明示的に除外しても main.py 側の挙動は完全に同一となる。
function transposeByDate(finalDataByCode) {
  const byDate = {};
  for (const [code, series] of Object.entries(finalDataByCode)) {
    if (series.error) continue;
    for (const [date, ohlcv] of Object.entries(series)) {
      byDate[date] ??= {};
      byDate[date][code] = ohlcv;
    }
  }
  return byDate;
}

// -----------------------------
// 4. 日付ごとのファイルパス・バックアップ関連ユーティリティ
// -----------------------------
const OHLCV_DIR = "data/ohlcv";
const BACKUP_DIR = "data/backup";
const BACKUP_KEEP = 8;

const pad = n => String(n).padStart(2, "0");

function nowJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function todayJst() {
  const n = nowJst();
  return `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}`;
}

function archivePath(date) {
  return path.join(OHLCV_DIR, date.slice(0, 6), `ohlcv_${date}.json`);
}

function backupBeforeOverwrite(filePath) {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const n = nowJst();
  const timestamp =
    `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}_` +
    `${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}`;
  fs.copyFileSync(filePath, path.join(BACKUP_DIR, `${path.basename(filePath)}.${timestamp}`));
}

function pruneBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith("ohlcv_")).sort();
  while (files.length > BACKUP_KEEP) {
    fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  }
}

// -----------------------------
// 5. 全銘柄を順次取得し、日付ごとのファイルとして書き出す
// -----------------------------
// 書き込み方針：
//   ・当日分（JST）：fetch.yml は1日に複数回実行されるため、実行のたびに上書きする
//     （上書き前にバックアップを取る）。
//   ・当日以外で既にファイルが存在する日付：確定済みの恒久記録として上書きしない
//     （data/heuristics/heuristics_YYYYMMDD.json と同じ「一度書いたら不変」の方針）。
//   ・当日以外でまだファイルが存在しない日付：FETCH_DAYS>1 で遡って取得した場合の
//     遡及生成（バックフィル）として新規に書き込む。
async function main() {
  let finalDataByCode = {};

  for (const code of symbols) {
    finalDataByCode[code] = await fetchSymbol(code);
    await new Promise(r => setTimeout(r, 500));
  }

  const byDate = transposeByDate(finalDataByCode);
  const today = todayJst();

  const dates = Object.keys(byDate).sort();
  if (dates.length === 0) {
    console.log("WARNING: 有効なOHLCVデータを1件も取得できませんでした。書き込みをスキップします。");
    return;
  }

  for (const date of dates) {
    const filePath = archivePath(date);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const alreadyExists = fs.existsSync(filePath);
    if (alreadyExists && date !== today) {
      console.log(`skip (archived, immutable): ${filePath}`);
      continue;
    }
    if (alreadyExists) backupBeforeOverwrite(filePath);

    fs.writeFileSync(filePath, JSON.stringify(byDate[date], null, 2));
    console.log(`saved: ${filePath}${alreadyExists ? " (overwritten: today)" : " (new)"}`);
  }

  pruneBackups();
}

main();
