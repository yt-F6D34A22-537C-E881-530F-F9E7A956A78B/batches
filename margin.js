import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import xlsx from "xlsx";
import { JSDOM } from "jsdom";
import iconv from "iconv-lite";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// ======================================================================
// Utility
// ======================================================================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function jstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function timestamp() {
  const now = jstNow();
  const pad = n => String(n).padStart(2, "0");
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) + "_" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

// Python版の unicodedata.normalize("NFKC", ...) 相当（簡易）
function normalizeNFKC(s) {
  return s.normalize("NFKC");
}

function normalizeCodeForReg(raw) {
  return normalizeNFKC(raw).replace(/\s+/g, "").replace("　", "");
}

// ======================================================================
// 1. JSF 貸借銘柄 meigara.csv（Shift_JIS, 1行目タイトル, 2行目ヘッダ, 3行目以降データ）
// ======================================================================
async function fetchKubunMap() {
  const url = "https://www.taisyaku.jp/data/meigara.csv";
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());

  const csv = iconv.decode(buf, "shift_jis");
  const lines = csv.split(/\r?\n/);

  if (lines.length < 3) {
    throw new Error("meigara.csv の行数が不足しています");
  }

  // 1行目: タイトル
  // 2行目: ヘッダ
  const headerLine = lines[1];
  const headers = headerLine.split(",");

  const codeIndex = headers.indexOf("コード");
  const kubunIndex = headers.indexOf("貸借銘柄区分（東証）");

  console.log("=== JSF meigara.csv HEADERS ===");
  console.log(headers);
  console.log("コード index =", codeIndex, " 貸借区分（東証） index =", kubunIndex);
  console.log("================================");

  if (codeIndex === -1 || kubunIndex === -1) {
    throw new Error("コード または 貸借銘柄区分（東証）列が見つかりません");
  }

  const kubunMap = {};

  // 3行目以降がデータ
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const cols = line.split(",");

    const rawCode = cols[codeIndex];
    const kubun = cols[kubunIndex];

    if (!rawCode) continue;

    // Python: unicodedata.normalize("NFKC", raw_code).zfill(4)
    const code = normalizeNFKC(String(rawCode)).padStart(4, "0");
    kubunMap[code] = String(kubun);
  }

  return kubunMap;
}

// ======================================================================
// 2. 楽天証券 規制スクレイピング（rowspan 対応）
// ======================================================================
async function fetchRakutenRegulation() {
  const url = "https://www.rakuten-sec.co.jp/ITS/Companyfile/margin_restriction.html";
  const res = await fetch(url);
  const html = await res.text();

  const dom = new JSDOM(html);
  const document = dom.window.document;

  const BUY_BAN_KEYWORDS = ["新規買停止", "全取引停止"];
  const SELL_BAN_KEYWORDS = ["新規売停止", "全取引停止"];
  const TOKYO_KEYWORDS = ["東京"];

  const rows = [...document.querySelectorAll("table tr")];
  const regulationMap = {};

  const current = Array(6).fill(null);
  const rowspanLeft = Array(6).fill(0);

  for (const tr of rows) {
    const tds = [...tr.querySelectorAll("td")];
    if (tds.length === 0) continue;

    const logical = Array(6).fill(null);
    let td_i = 0;

    // rowspan 継承
    for (let col = 0; col < 6; col++) {
      if (rowspanLeft[col] > 0) {
        logical[col] = current[col];
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
        current[col] = text;
      }

      td_i++;
    }

    const rawCode = logical[0];
    const market = logical[2];
    const text = logical[3];

    if (!rawCode) continue;

    // Python: unicodedata.normalize("NFKC", raw_code)
    const code = normalizeNFKC(String(rawCode));

    // 市場フィルタ（東京のみ）
    let marketFlag = false;
    if (market) {
      const m = normalizeNFKC(String(market)).replace(/\s+/g, "").replace("　", "");
      marketFlag = TOKYO_KEYWORDS.some(k => m.includes(k));
    }
    if (!marketFlag) continue;

    regulationMap[code] = regulationMap[code] || [];
    regulationMap[code].push(text);
  }

  return { regulationMap, BUY_BAN_KEYWORDS, SELL_BAN_KEYWORDS };
}

// ======================================================================
// 3. JPX 週次 PDF（pdfjs-dist, 281A0 対応）
// ======================================================================
async function fetchJpxWeekly() {
  const page = "https://www.jpx.co.jp/markets/statistics-equities/margin/05.html";
  const res = await fetch(page);
  const html = await res.text();

  const dom = new JSDOM(html);
  const document = dom.window.document;

  const pdfLinks = [...document.querySelectorAll("a")]
    .map(a => a.href)
    .filter(h => h.endsWith(".pdf") && h.includes("syumatsu"))
    .map(h => "https://www.jpx.co.jp" + h);

  if (pdfLinks.length === 0) return {};

  const latest = pdfLinks.sort().slice(-1)[0];
  const pdfRes = await fetch(latest);
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

  const jpxMap = {};

  function parseNum(s) {
    s = s.replace(/,/g, "").replace(/\s+/g, "");
    if (s === "" || s === "▲") return 0;
    if (s.startsWith("▲")) return -parseInt(s.slice(1));
    return parseInt(s);
  }

  for (const block of blocks) {
    const m = block.match(/([0-9A-Z]{4}0)\s+JP\d{10}/);
    if (!m) continue;

    const rawCode5 = m[1]; // 例: 281A0, 72030
    const code4 = normalizeNFKC(rawCode5.slice(0, 4)); // 例: 281A, 7203

    const afterIsin = block.split(/JP\d{10}/)[1] || "";
    const nums = (afterIsin.match(/[▲\-]?\s*[\d,]+/g) || []).map(parseNum);

    if (nums.length < 4) continue;

    const [sell, sellDiff, buy, buyDiff] = nums;
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

// ======================================================================
// 4. JPX 日々公表 XLS（Python版と同じ列名・ヘッダ行）
// ======================================================================
async function fetchJpxDaily() {
  const index = "https://www.jpx.co.jp/markets/statistics-equities/margin/index.html";
  const res = await fetch(index);
  const html = await res.text();

  const dom = new JSDOM(html);
  const document = dom.window.document;

  const links = [...document.querySelectorAll("a")]
    .map(a => a.href)
    .filter(h => /mtdailyk.*\.xls$/.test(h));

  if (links.length === 0) return {};

  const latest = links.sort().slice(-1)[0];
  const url = "https://www.jpx.co.jp" + latest;

  const buf = await (await fetch(url)).arrayBuffer();
  const wb = xlsx.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];

  // Python: header=5 → 6行目がヘッダ
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 0, range: 5 });

  const codeCol = "コード";
  const sellCol = "売残高 Outstanding Sales";
  const buyCol = "買残高 Outstanding Purchases";

  const dailyMap = {};

  for (const row of rows) {
    const raw = String(row[codeCol] || "").trim();
    if (!/^[0-9A-Z]{4}0$/.test(raw)) continue;

    const code4 = normalizeNFKC(raw.slice(0, 4));

    const sellStr = String(row[sellCol] || "0").replace(/,/g, "");
    const buyStr = String(row[buyCol] || "0").replace(/,/g, "");

    const sell = parseInt(sellStr);
    const buy = parseInt(buyStr);

    if (Number.isNaN(sell) || Number.isNaN(buy)) continue;

    dailyMap[code4] = { sell, buy };
  }

  return dailyMap;
}

// ======================================================================
// 5. 日々公表で jpx_map を事前上書き（Python版と同じ）
// ======================================================================
function applyDailyToWeekly(jpxMap, dailyMap) {
  for (const [code4, d] of Object.entries(dailyMap)) {
    const newBuy = d.buy;
    const newSell = d.sell;

    if (jpxMap[code4]) {
      const prevBuy = jpxMap[code4].buy ?? 0;
      const prevSell = jpxMap[code4].sell ?? 0;

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

// ======================================================================
// 6. margin.json 統合（規制 + 日々公表 + 制度信用可否）
// ======================================================================
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
    // Python: kubun in (None, "0") は出力しない
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
      "JPX信用買残": jpx.buy,
      "JPX信用買残前週比": jpx.buy_diff,
      "JPX信用売残": jpx.sell,
      "JPX信用売残前週比": jpx.sell_diff,
      "JPX信用倍率": jpx.ratio,
      "規制": regs
    };
  }

  return margin;
}

// ======================================================================
// 7. バックアップ & 古いバックアップ削除（ファイル版）
// ======================================================================
function backupMargin() {
  ensureDir("data/backup");

  const ts = timestamp();
  if (fs.existsSync("data/margin.json")) {
    fs.copyFileSync("data/margin.json", `data/margin.json.${ts}`);
    fs.copyFileSync("data/margin.json", `data/backup/margin.json.${ts}`);
  }
}

function cleanupBackups() {
  const dir = "data/backup";
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir);
  for (const f of files) {
    const m = f.match(/margin\.json\.(\d{8}_\d{6})$/);
    if (!m) continue;

    const t = m[1];
    const dt = new Date(
      t.slice(0, 4),
      t.slice(4, 6) - 1,
      t.slice(6, 8),
      t.slice(9, 11),
      t.slice(11, 13),
      t.slice(13, 15)
    );

    const diffDays = (jstNow() - dt) / (1000 * 60 * 60 * 24);
    if (diffDays > 3) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
}

// ======================================================================
// 8. Main
// ======================================================================
async function main() {
  ensureDir("data");

  const kubunMap = await fetchKubunMap();
  const { regulationMap, BUY_BAN_KEYWORDS, SELL_BAN_KEYWORDS } =
    await fetchRakutenRegulation();
  const jpxMap = await fetchJpxWeekly();
  const dailyMap = await fetchJpxDaily();

  // Python版と同様に、jpx_map を事前に日々公表で上書き
  applyDailyToWeekly(jpxMap, dailyMap);

  const margin = buildMarginJson(
    kubunMap,
    regulationMap,
    BUY_BAN_KEYWORDS,
    SELL_BAN_KEYWORDS,
    jpxMap
  );

  fs.writeFileSync("data/margin.json", JSON.stringify(margin, null, 2), "utf-8");

  backupMargin();
  cleanupBackups();

  console.log("✔ margin.json 更新完了");
}

main();
