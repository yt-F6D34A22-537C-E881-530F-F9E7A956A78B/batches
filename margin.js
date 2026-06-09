import fetch from "node-fetch";
import fs from "fs";
import xlsx from "xlsx";
import { JSDOM } from "jsdom";
import iconv from "iconv-lite";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// ============================================================
// Utility
// ============================================================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeNFKC(s) {
  return s.normalize("NFKC");
}

// ============================================================
// 1. JSF 貸借銘柄（meigara.csv, Shift_JIS）
//    - 1行目: タイトル
//    - 2行目: ヘッダ
//    - 3行目以降: データ
// ============================================================
async function fetchKubunMap() {
  const url = "https://www.taisyaku.jp/data/meigara.csv";
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const csv = iconv.decode(buf, "shift_jis");

  const lines = csv.split(/\r?\n/);
  if (lines.length < 3) return {};

  const headerLine = lines[1];
  const headers = headerLine.split(",");
  const codeIndex = headers.indexOf("コード");
  const kubunIndex = headers.indexOf("貸借銘柄区分（東証）");

  const kubunMap = {};

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const cols = line.split(",");
    const rawCode = cols[codeIndex];
    const kubun = cols[kubunIndex];

    if (!rawCode) continue;

    const code = normalizeNFKC(String(rawCode)).padStart(4, "0");
    kubunMap[code] = String(kubun);
  }

  return kubunMap;
}

// ============================================================
// 2. 楽天証券 規制ページ（EUC-JP, rowspan 対応）
//    - Python 版と同じロジック：
//      * encoding = apparent_encoding（実際は EUC-JP）
//      * table tr → td を 6 列論理配列に展開
//      * logical[0] = コード
//      * logical[2] = 市場
//      * logical[3] = 規制文言
//      * TOKYO_KEYWORDS = ["東京"]
// ============================================================
async function fetchRakutenRegulation() {
  const url = "https://www.rakuten-sec.co.jp/ITS/Companyfile/margin_restriction.html";
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  // margin.restriction.htmlの文字コードであるEUC-JP でデコード
  const html = iconv.decode(buf, "EUC-JP");

  const dom = new JSDOM(html);
  const document = dom.window.document;

  // ============================================================
  // 楽天証券 規制文言辞書（出典：公式ページ）
  // https://www.rakuten-sec.co.jp/ITS/qaOth0007.html
  //
  // 【公式ページに掲載されている規制文言一覧】
  // - 整理銘柄
  // - 監理銘柄（審査中）
  // - 監理銘柄（確認中）
  // - 特別注意銘柄
  // - 監視区分銘柄
  // - 増担保***％（うち現金***％）
  // - レバETF
  // - 日々公表銘柄
  // - 貸株注意喚起
  // - 申告規制
  // - 即日預託
  // - 制度信用社内規制
  // - 一般信用社内規制
  // - 建玉上限
  //
  // - 代用掛目規制***％
  // - 代用掛目規制予定***％
  //
  // - 新規買停止
  // - 一般信用新規買停止
  // - 新規売停止
  // - 一般信用新規売停止
  // - 返済買埋停止
  // - 一般信用返済買埋停止
  // - 返済売埋停止
  // - 一般信用返済売埋停止
  // - 現引停止
  // - 一般信用現引停止
  // - 現渡停止
  // - 一般信用現渡停止
  // - 全取引停止
  // - 現物売付停止
  // - 現物買付停止
  //
  // 【採用した文言】
  // - 新規買停止 → BUY_BAN_KEYWORDS に採用
  // - 新規売停止 → SELL_BAN_KEYWORDS に採用
  // - 全取引停止 → BUY/SELL 両方に採用
  //
  // 【採用しなかった文言と理由】
  // - 「整理銘柄」「監理銘柄」「特別注意銘柄」など → 新規建て可否に直接影響しないため
  // - 「増担保」「代用掛目規制」 → 新規建て可否ではなく担保率の問題のため
  // - 「レバETF」 → 種類分類であり規制ではないため
  // - 「日々公表銘柄」 → 注意喚起であり新規建て可否には影響しないため
  // - 「貸株注意喚起」 → 同上
  // - 「申告規制」「即日預託」 → 新規建て可否とは別種の規制のため
  // - 「現引停止」「現渡停止」 → 決済方法の制限であり新規建て可否とは別
  // - 「現物売付停止」「現物買付停止」 → 現物取引の規制であり信用取引の新規建てとは無関係
  // ============================================================
  const BUY_BAN_KEYWORDS = ["新規買停止", "全取引停止"];
  const SELL_BAN_KEYWORDS = ["新規売停止", "全取引停止"];
  const TOKYO_KEYWORDS = ["東京"];

  const rows = [...document.querySelectorAll("table tr")];
  const regulationMap = {};

  const currentVals = Array(6).fill(null);
  const rowspanLeft = Array(6).fill(0);

  for (const tr of rows) {
    const tds = [...tr.querySelectorAll("td")];
    if (tds.length === 0) continue;

    const logical = Array(6).fill(null);
    let td_i = 0;

    // rowspan 継承
    for (let col = 0; col < 6; col++) {
      if (rowspanLeft[col] > 0) {
        logical[col] = currentVals[col];
        rowspanLeft[col]--;
      }
    }

    // 通常セル
    for (let col = 0; col < 6; col++) {
      if (logical[col] !== null) continue;
      if (td_i >= tds.length) break;

      const td = tds[td_i];
      const text = td.textContent.trim();
      logical[col] = text;

      const rs = td.getAttribute("rowspan");
      if (rs) {
        rowspanLeft[col] = parseInt(rs) - 1;
        currentVals[col] = text;
      }

      td_i++;
    }

    const rawCode = logical[0];
    const market = logical[2];
    const text = logical[3];

    if (!rawCode) continue;

    const code = normalizeNFKC(String(rawCode));

    // 市場フィルタ（Python 版と同じく "東京" を含むかどうか）
    let marketFlag = false;
    if (market) {
      const m = normalizeNFKC(String(market)).replace(/ /g, "").replace(/　/g, "");
      marketFlag = TOKYO_KEYWORDS.some(k => m.includes(k));
    }
    if (!marketFlag) continue;

    // 規制文言を格納（全銘柄）
    if (!regulationMap[code]) regulationMap[code] = [];
    regulationMap[code].push(text);
  }

  return { regulationMap, BUY_BAN_KEYWORDS, SELL_BAN_KEYWORDS };
}

// ============================================================
// 3. JPX 週次 PDF（281A0 対応）
// ============================================================
async function fetchJpxWeekly() {
  const page = "https://www.jpx.co.jp/markets/statistics-equities/margin/05.html";
  const res = await fetch(page);
  const html = await res.text();

  const dom = new JSDOM(html);
  const document = dom.window.document;

  const pdfLinks = [...document.querySelectorAll("a")]
    .map(a => a.href)
    .filter(href => href.endsWith(".pdf") && href.includes("syumatsu"))
    .map(href => "https://www.jpx.co.jp" + href);

  if (pdfLinks.length === 0) return {};

  const latestPdf = pdfLinks.sort().slice(-1)[0];
  const pdfRes = await fetch(latestPdf);
  const pdfBuf = await pdfRes.arrayBuffer();

  const pdfDoc = await getDocument({ data: pdfBuf }).promise;

  let fullText = "";
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map(it => it.str).join(" ");
    fullText += "\n" + strings;
  }

  const blocks = fullText.split(/(?=[0-9A-Z]{4}0\s+JP\d{10})/);

  function parseNum(s) {
    s = s.replace(/,/g, "").replace(/ /g, "");
    if (s === "" || s === "▲") return 0;
    if (s.startsWith("▲")) return -parseInt(s.slice(1));
    return parseInt(s);
  }

  const jpxMap = {};

  for (const block of blocks) {
    const m = block.match(/([0-9A-Z]{4}0)\s+JP\d{10}/);
    if (!m) continue;

    const rawCode5 = m[1]; // 例: 281A0, 72030
    const code4 = normalizeNFKC(rawCode5.slice(0, 4)); // 例: 281A, 7203

    const afterIsin = block.split(/JP\d{10}/)[1] || "";
    const nums = (afterIsin.match(/[▲\-]?\s*[\d,]+/g) || []).map(parseNum);

    if (nums.length < 4) continue;

    const sell = nums[0];
    const sellDiff = nums[1];
    const buy = nums[2];
    const buyDiff = nums[3];
    const ratio = sell !== 0 ? Math.round((buy / sell) * 100) / 100 : null;

    jpxMap[code4] = {
      buy,
      buy_diff: buyDiff,
      sell,
      sell_diff: sellDiff,
      ratio
    };
  }

  return jpxMap;
}

// ============================================================
// 4. JPX 日々公表（XLS, 281A0 対応）
// ============================================================
async function fetchJpxDaily() {
  const index = "https://www.jpx.co.jp/markets/statistics-equities/margin/index.html";
  const res = await fetch(index);
  const html = await res.text();

  const dom = new JSDOM(html);
  const document = dom.window.document;

  const links = [...document.querySelectorAll("a")]
    .map(a => a.href)
    .filter(href => /mtdailyk.*\.xls$/.test(href));

  if (links.length === 0) return {};

  const latestDaily = links.sort().slice(-1)[0];
  const dailyUrl = "https://www.jpx.co.jp" + latestDaily;

  const buf = await (await fetch(dailyUrl)).arrayBuffer();
  const wb = xlsx.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];

  const rows = xlsx.utils.sheet_to_json(sheet, { header: 0, range: 5 });

  const codeCol = "コード";
  const sellCol = "売残高 Outstanding Sales";
  const buyCol = "買残高 Outstanding Purchases";

  const dailyMap = {};

  for (const row of rows) {
    const raw = String(row[codeCol] || "").trim();
    if (!/^[0-9A-Z]{4}0$/.test(raw)) continue;

    const code4 = normalizeNFKC(raw.slice(0, 4));

    const sell = parseInt(String(row[sellCol] || "0").replace(/,/g, ""));
    const buy = parseInt(String(row[buyCol] || "0").replace(/,/g, ""));

    if (Number.isNaN(sell) || Number.isNaN(buy)) continue;

    dailyMap[code4] = { sell, buy };
  }

  return dailyMap;
}

// ============================================================
// 5. 日々公表で週次を上書き（Python 版と同等）
// ============================================================
function applyDailyToWeekly(jpxMap, dailyMap) {
  for (const [code4, d] of Object.entries(dailyMap)) {
    const newBuy = d.buy;
    const newSell = d.sell;

    if (jpxMap[code4]) {
      const prevBuy = jpxMap[code4].buy;
      const prevSell = jpxMap[code4].sell;

      jpxMap[code4].buy = newBuy;
      jpxMap[code4].sell = newSell;
      jpxMap[code4].buy_diff = newBuy - prevBuy;
      jpxMap[code4].sell_diff = newSell - prevSell;
      jpxMap[code4].ratio = newSell !== 0 ? Math.round((newBuy / newSell) * 100) / 100 : null;
    } else {
      jpxMap[code4] = {
        buy: newBuy,
        buy_diff: null,
        sell: newSell,
        sell_diff: null,
        ratio: newSell !== 0 ? Math.round((newBuy / newSell) * 100) / 100 : null
      };
    }
  }
}

// ============================================================
// 6. margin.json 統合（規制 + 日々公表 + 上書き対応）
//    - Python 版のロジックを忠実に移植
// ============================================================
function buildMarginJson(kubunMap, regulationMap, BUY_BAN, SELL_BAN, jpxMap) {
  const margin = {};

  const allCodes = [
    ...Object.keys(regulationMap),
    ...Object.keys(kubunMap),
    ...Object.keys(jpxMap)
  ];
  const uniqCodes = [...new Set(allCodes)];

  for (const rawCode of uniqCodes) {
    const code = normalizeNFKC(String(rawCode));
    const kubun = kubunMap[code];

    // 貸借区分 0（非制度信用銘柄）、null（meigara.csvに記載なし）は出力しない
    if (kubun === undefined || kubun === null || kubun === "0") continue;

    const regs = regulationMap[code] || [];
    const jpx = jpxMap[code] || {};

    const hasSellBan = regs.some(r => SELL_BAN.some(k => r.includes(k)));
    const hasBuyBan = regs.some(r => BUY_BAN.some(k => r.includes(k)));

    const seiBuy = !hasBuyBan;
    const seiSell = kubun === "1" && !hasSellBan;

    margin[code] = {
      "貸借区分": kubun,
      "制度信用": {
        "買い建て": seiBuy,
        "売り建て": seiSell
      },
      "JPX信用買残": jpx.buy ?? null,
      "JPX信用買残前週比": jpx.buy_diff ?? null,
      "JPX信用売残": jpx.sell ?? null,
      "JPX信用売残前週比": jpx.sell_diff ?? null,
      "JPX信用倍率": jpx.ratio ?? null,
      "規制": regs
    };
  }

  return margin;
}

// ============================================================
// 7. Main
// ============================================================
async function main() {
  ensureDir("data");

  const kubunMap = await fetchKubunMap();
  const { regulationMap, BUY_BAN_KEYWORDS, SELL_BAN_KEYWORDS } =
    await fetchRakutenRegulation();
  const jpxMap = await fetchJpxWeekly();
  const dailyMap = await fetchJpxDaily();

  applyDailyToWeekly(jpxMap, dailyMap);

  const margin = buildMarginJson(
    kubunMap,
    regulationMap,
    BUY_BAN_KEYWORDS,
    SELL_BAN_KEYWORDS,
    jpxMap
  );

  // コードの昇順にソート
  const sorted = {};
  for (const code of Object.keys(margin).sort()) {
    sorted[code] = margin[code];
  }
  
  fs.writeFileSync("data/margin.json", JSON.stringify(margin, null, 2), "utf-8");
}

main();
