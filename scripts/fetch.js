import fetch from "node-fetch";
import fs from "fs";
import xlsx from "xlsx";
import path from "path";
import { getCrumb, YAHOO_REQUEST_HEADERS } from "./lib/yahoo_finance_auth.js";
import { formatDateJst } from "./lib/jst_time.js";
import { backupFile, pruneKeepNewest } from "./lib/backup_utils.js";

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

// getCrumb・cookieHeaderFromは共通化のため scripts/lib/yahoo_finance_auth.js へ移動した（2026-07）。

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
      const res = await fetch(url, { headers: { ...YAHOO_REQUEST_HEADERS, Cookie: auth.cookie } });
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
  const auth = await getCrumb(); // デフォルトのWARNING（crumb失敗時はv8へフォールバックするため）
  if (!auth) return null; // crumb自体が取れない場合は呼び出し元でv8方式へフォールバックする

  const finalDataByCode = {};
  const batches = chunk(codes, V7_BATCH_SIZE);

  // v7/finance/quote は「当日時点のスナップショット」を返す設計だが、長期間売買が成立していない
  // 銘柄（整理・監理銘柄、出来高極少の銘柄等）に対しては、Yahoo側が何ヶ月〜何年も前の
  // regularMarketTime をそのまま返すことがある（2026-07 実運用で確認。ohlcv_20240627.json 等、
  // 本来存在しないはずの過去日付ファイルが少数銘柄だけで新規生成される不具合の原因だった）。
  // このため、全バッチの取得が完了するまで確定させず、まず正常取得できた銘柄のOHLCVを
  // pendingByCode に保留し、日付の妥当性は全銘柄が出揃ってから判定する（詳細は下記を参照）。
  const pendingByCode = {};

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
      if (!ohlcv) {
        finalDataByCode[code] = { error: "incomplete OHLCV fields from v7 quote" };
        continue;
      }
      pendingByCode[code] = ohlcv;
    }
    // レスポンスに含まれなかった銘柄（上場廃止・コード相違等）もエラー扱いにする
    for (const code of batchCodes) {
      if (!returnedCodes.has(code)) finalDataByCode[code] = { error: "not returned by v7 quote batch" };
    }

    console.log(`${label} 完了（${list.length}/${batchCodes.length}銘柄）`);
    await new Promise(r => setTimeout(r, V7_BATCH_INTERVAL_MS));
  }

  // 正常取得できた銘柄群のうち、最も多くの銘柄が指している日付（最頻値）を
  // 「このバッチ全体が指し示す最新営業日」とみなす。
  //
  // 実行時点の「今日（JST）」と直接比較しないのは、実行が遅延した場合
  // （例: 金曜分の取得が実行できず土曜に持ち越された場合）でも、v7が返す
  // 実際の最新営業日（金曜）を正しく採用できるようにするため。
  //
  // 最大値（最も新しい日付）ではなく最頻値を使うのは、ごく少数の銘柄が
  // 何らかの理由で異常な日付（古い/新しいいずれも）を報告した場合に、
  // その外れ値へ基準日が引きずられ、大多数の正しいデータの方が誤って
  // 除外されるのを防ぐため。
  const dateCounts = {};
  for (const ohlcv of Object.values(pendingByCode)) {
    const d = Object.keys(ohlcv)[0];
    dateCounts[d] = (dateCounts[d] || 0) + 1;
  }
  const majorityDate = Object.entries(dateCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  let staleCount = 0;
  for (const [code, ohlcv] of Object.entries(pendingByCode)) {
    const d = Object.keys(ohlcv)[0];
    if (d === majorityDate) {
      finalDataByCode[code] = ohlcv;
    } else {
      finalDataByCode[code] = { error: `stale quote from v7 (regularMarketTime date=${d}, batch majority date=${majorityDate})` };
      staleCount++;
    }
  }
  if (staleCount > 0) {
    console.log(`WARNING: v7取得銘柄のうち${staleCount}件は、バッチ全体の最頻日付（${majorityDate}）と異なるregularMarketTimeのため除外しました。`);
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
// pad・nowJst・todayJst・backupBeforeOverwrite・pruneBackupsは、
// margin.js・download-jpx-xlsx.js・heuristics.jsとの重複ロジックを
// scripts/lib/jst_time.js・scripts/lib/backup_utils.js へ共通化した（2026-07）。
const OHLCV_DIR = "data/ohlcv";
const BACKUP_DIR = "data/backup";
const BACKUP_KEEP = 8;

function archivePath(date) {
  return path.join(OHLCV_DIR, date.slice(0, 6), `ohlcv_${date}.json`);
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
  const today = formatDateJst();

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
    if (alreadyExists) backupFile(filePath, BACKUP_DIR);

    fs.writeFileSync(filePath, JSON.stringify(byDate[date], null, 2));
    console.log(`saved: ${filePath}${alreadyExists ? " (overwritten: today)" : " (new)"}`);
  }

  pruneKeepNewest(BACKUP_DIR, f => f.startsWith("ohlcv_"), BACKUP_KEEP);
}

main();
