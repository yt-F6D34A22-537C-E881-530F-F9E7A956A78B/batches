import fetch from "node-fetch";
import fs from "fs";
import xlsx from "xlsx";
import { getCrumb, YAHOO_REQUEST_HEADERS } from "./lib/yahoo_finance_auth.js";

// -----------------------------
// 1. Excel から銘柄コードを読み込む（fetch.js と同一の手順・同一ファイルを再利用）
//    download-jpx-xlsx.js が生成する data/data_j.xlsx は、fetch.js 実行時と
//    同様にこのワークフロー実行時にも checkout 済みのリポジトリ内に
//    存在している前提（別途ダウンロードし直さない）。
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
// 2. Yahoo Finance API（quoteエンドポイント。発行済株式数〔sharesOutstanding〕を含む）
//
//    fetch.js は v8/finance/chart を1銘柄ずつ呼んでいるが、時価総額算出に必要な
//    発行済株式数だけであれば v7/finance/quote が適しており、かつ symbols= に
//    カンマ区切りで複数銘柄をまとめて指定できる。対象銘柄数が多い
//    （約4000銘柄）本スクリプトでは、1銘柄ずつ呼ぶと外部通信回数が
//    Yahoo Finance側のレート制限に抵触しやすくなるため、バッチ化して
//    通信回数を抑える（fetch.js と同じ「生のfetchでYahoo Finance APIを叩く」
//    方式は踏襲しつつ、エンドポイントと呼び出し粒度のみ用途に合わせて変更している）。
//
//    2026-07 修正: v7/finance/quote は crumb（ワンタイムトークン）＋
//    セッションCookieが無いと401 Unauthorizedを返すようになっていた
//    （本番でmarket_cap.jsonが空のまま更新できていなかった不具合の原因）。
//    実行開始時に一度だけ crumb+Cookie を取得し、全バッチで使い回す
//    （crumbはセッション単位のトークンであり、リクエストごとに取り直す
//    必要はない。取得手順はYahoo非公式・コミュニティ報告ベース）。
//
//    あわせて BATCH_SIZE を 50 → 2000 に引き上げた。実地検証の結果、
//    2000銘柄（URL長 約18,000文字）までは成功し、3000銘柄
//    （URL長 約27,000文字）では Yahoo 側のWebサーバーが
//    "431 Request Header Fields Too Large" を返すことを確認済みのため、
//    安全マージンを見て2000に設定している。これにより
//    89バッチ→3バッチ（4437銘柄の場合）に削減され、実行時間も大幅に
//    短縮される。
// -----------------------------
const BATCH_SIZE = 2000;
const REQUEST_INTERVAL_MS = 500; // fetch.js と同じリクエスト間隔

function chunk(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

// crumb+Cookie取得手順はYahoo公式ドキュメントが存在しないため、コミュニティで
// 報告されている非公式な手順（fc.yahoo.comへのアクセスでセッションCookieを得て、
// query2.finance.yahoo.com/v1/test/getcrumb でcrumbを取得する）を踏襲している。
// getCrumb・cookieHeaderFromは共通化のため scripts/lib/yahoo_finance_auth.js へ移動した（2026-07）。

async function fetchSharesOutstandingBatch(codes, auth) {
  const symbolsParam = codes.map(code => `${code}.T`).join(",");
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbolsParam}&crumb=${encodeURIComponent(auth.crumb)}`;

  try {
    const res = await fetch(url, { headers: { ...YAHOO_REQUEST_HEADERS, Cookie: auth.cookie } });
    const json = await res.json();

    const list = json.quoteResponse?.result;
    if (!list) {
      console.log(`ERROR: ${json.quoteResponse?.error?.description || "Unknown error from Yahoo Finance"}`);
      return {};
    }

    let result = {};

    for (const item of list) {
      const code = String(item.symbol).replace(/\.T$/, "");
      if (item.sharesOutstanding) {
        result[code] = item.sharesOutstanding;
      }
    }

    return result;

  } catch (err) {
    console.log("ERROR: Network or fetch error");
    return {};
  }
}

// -----------------------------
// 3. 全銘柄をバッチ単位で順次取得
// -----------------------------
async function main() {
  const auth = await getCrumb("ERROR"); // フォールバックが無いためERROR扱い（既存挙動を維持）
  if (!auth) {
    console.log("ERROR: crumb取得に失敗したため処理を中断します。data/market_cap.json は更新しません（前回分を保持）。");
    process.exit(1);
  }

  let marketCap = {};
  const batches = chunk(symbols, BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batchResult = await fetchSharesOutstandingBatch(batches[i], auth);
    marketCap = { ...marketCap, ...batchResult };

    console.log(`進捗: ${i + 1}/${batches.length} バッチ`);

    await new Promise(r => setTimeout(r, REQUEST_INTERVAL_MS));
  }

  // -----------------------------
  // 4. market_cap.json を洗い替え
  //    data.json と異なり日次で大きく変動する値ではないため、
  //    fetch.js のようなバックアップ・世代管理は行わない
  //    （発行済株式数は変化が緩やかで、仮に1回分の取得に失敗しても
  //    翌週の実行で自然に更新されるため、過去分を保持する必要性が薄い）。
  // -----------------------------
  fs.writeFileSync("data/market_cap.json", JSON.stringify(marketCap));

  console.log(`取得完了: ${Object.keys(marketCap).length}/${symbols.length} 銘柄 → data/market_cap.json`);
}

main();
