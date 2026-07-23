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
// 2. Yahoo Finance API（取得経路は FETCH_DAYS に応じて切り替える）
//
//    2026-07 追加: FETCH_DAYS=1（通常運転・当日分のみの更新）の場合は、
//    v8/finance/chart を4,400銘柄ぶん1件ずつ呼ぶ（実測で約45分）代わりに、
//    v7/finance/quote で複数銘柄をバッチ取得する経路を優先的に使う
//    （実測で数バッチ・数秒〜十数秒程度に短縮される）。
//    v7/finance/quote は「当日時点のスナップショット」のみを返す設計のため、
//    FETCH_DAYS>1（過去分の遡及取得）の場合は従来通り v8/finance/chart を使う。
//
//    v7/finance/quote は crumb（ワンタイムトークン）＋セッションCookieが
//    無いと401を返すため、scripts/fetch_market_cap.js と同じ非公式な
//    crumb取得手順を踏襲している（Yahoo公式のドキュメントは存在しない）。
//    crumb取得自体に失敗した場合は、この非公式な仕組みがいつ壊れても
//    日次更新自体は止まらないよう、v8/finance/chart による従来方式に
//    自動フォールバックする（詳細は main() 内を参照）。
// -----------------------------

// v7/finance/quote のバッチサイズ上限。実地検証で2000銘柄（URL長 約18,000文字）
// までは成功し、3000銘柄（URL長 約27,000文字）では Yahoo 側のWebサーバーが
// "431 Request Header Fields Too Large" を返すことを確認済みのため、
// 安全マージンを見て2000に設定している（fetch_market_cap.js と同じ値）。
const V7_BATCH_SIZE = 2000;
const V7_BATCH_INTERVAL_MS = 1000;

function chunk(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

function cookieHeaderFrom(setCookieArray) {
  return (setCookieArray || []).map(sc => sc.split(";")[0]).join("; ");
}

async function getCrumb() {
  const cookieRes = await fetch("https://fc.yahoo.com", { redirect: "manual" });
  // node-fetch の Headers#raw() は Set-Cookie を複数持つ場合でも全件配列で返す
  // （Headers#get("set-cookie") だと1件目しか取れず、必要なCookieを取りこぼす）
  const setCookies = cookieRes.headers.raw()["set-cookie"] || [];
  const cookie = cookieHeaderFrom(setCookies);
  if (!cookie) {
    console.log("WARNING: セッションCookieを取得できませんでした。");
    return null;
  }

  const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { Cookie: cookie },
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes("<html") || crumbRes.status !== 200) {
    console.log("WARNING: crumbを取得できませんでした。");
    return null;
  }
  return { crumb, cookie };
}

// v7/finance/quote の1銘柄ぶんのレスポンスから、fetchSymbol() と同じ
// { [YYYYMMDD]: {o,h,l,c,v} } 形に変換する。日付キーの導出方法（実行環境の
// ローカルタイムゾーンに依存する点も含む）は fetchSymbol() と完全に揃えている。
function extractOhlcvFromQuoteItem(item) {
  const o = item.regularMarketOpen;
  const h = item.regularMarketDayHigh;
  const l = item.regularMarketDayLow;
  const c = item.regularMarketPrice;
  const v = item.regularMarketVolume;
  const ts = item.regularMarketTime; // UNIX秒

  if (o == null || h == null || l == null || c == null || v == null || typeof ts !== "number") {
    return null;
  }

  const date = new Date(ts * 1000);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const key = `${y}${m}${d}`;

  return { [key]: { o, h, l, c, v } };
}

// 1バッチぶんのv7/finance/quoteを取得する。ネットワーク瞬断等の一時的な
// 失敗を考慮し、1回だけリトライする。それでも失敗した場合は、そのバッチに
// 含まれる銘柄だけをエラー扱いにして続行する（1バッチの失敗で全体を
// 巻き込まないようにするため。crumb自体の失敗とは切り分けている）。
async function fetchQuoteBatchWithRetry(batchCodes, auth, batchLabel) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const symbolsParam = batchCodes.map(code => `${code}.T`).join(",");
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbolsParam}&crumb=${encodeURIComponent(auth.crumb)}`;
      const res = await fetch(url, { headers: { Cookie: auth.cookie } });
      const json = await res.json();
      const list = json.quoteResponse?.result;

      if (!list) {
        throw new Error(json.quoteResponse?.error?.description || "Unknown error from Yahoo Finance");
      }
      return list;
    } catch (err) {
      console.log(`WARNING: ${batchLabel} 取得失敗（試行${attempt}/2）: ${err.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }
  return null; // 2回とも失敗
}

async function fetchViaV7QuoteBatch(codes) {
  const auth = await getCrumb();
  if (!auth) return null; // crumb自体が取れない場合は呼び出し元でv8方式へフォールバックする

  const finalDataByCode = {};
  const batches = chunk(codes, V7_BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batchCodes = batches[i];
    const label = `v7バッチ ${i + 1}/${batches.length}`;
    const list = await fetchQuoteBatchWithRetry(batchCodes, auth, label);

    if (!list) {
      // このバッチは2回とも失敗。含まれる銘柄をエラー扱いにして続行する
      for (const code of batchCodes) finalDataByCode[code] = { error: "v7 batch fetch failed" };
      continue;
    }

    const returnedCodes = new Set();
    for (const item of list) {
      const code = String(item.symbol).replace(/\.T$/, "");
      returnedCodes.add(code);

      const ohlcv = extractOhlcvFromQuoteItem(item);
      finalDataByCode[code] = ohlcv || { error: "incomplete OHLCV fields from v7 quote" };
    }
    // レスポンスに含まれなかった銘柄（上場廃止・コード相違等）もエラー扱いにする
    for (const code of batchCodes) {
      if (!returnedCodes.has(code)) finalDataByCode[code] = { error: "not returned by v7 quote batch" };
    }

    console.log(`${label} 完了（${list.length}/${batchCodes.length}銘柄）`);
    await new Promise(r => setTimeout(r, V7_BATCH_INTERVAL_MS));
  }

  return finalDataByCode;
}

async function fetchViaV8ChartAll(codes) {
  const finalDataByCode = {};
  for (const code of codes) {
    finalDataByCode[code] = await fetchSymbol(code);
    await new Promise(r => setTimeout(r, 500));
  }
  return finalDataByCode;
}

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
  let finalDataByCode;

  if (FETCH_DAYS === 1) {
    console.log("FETCH_DAYS=1（当日分のみ）のため、v7/finance/quoteの一括取得を試みます。");
    finalDataByCode = await fetchViaV7QuoteBatch(symbols);
    if (!finalDataByCode) {
      console.log("v7/finance/quoteのcrumb取得に失敗したため、従来方式（v8/finance/chartを1銘柄ずつ）にフォールバックします。");
      finalDataByCode = await fetchViaV8ChartAll(symbols);
    }
  } else {
    console.log(`FETCH_DAYS=${FETCH_DAYS}（複数日・遡及取得）のため、v8/finance/chartを使用します（v7/finance/quoteは当日分のスナップショットのみ対応のため非対応）。`);
    finalDataByCode = await fetchViaV8ChartAll(symbols);
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
