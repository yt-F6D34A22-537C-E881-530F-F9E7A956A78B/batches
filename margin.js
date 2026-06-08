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

function normalizeCode(code) {
  return code.replace(/\s+/g, "").replace("　", "");
}

// ======================================================================
// 1. JSF 貸借銘柄 meigara.csv（Shift_JIS 対応）
// ======================================================================
async function fetchKubunMap() {
  const url = "https://www.taisyaku.jp/data/meigara.csv";
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());

  // Shift_JIS → UTF-8
  const csv = iconv.decode(buf, "shift_jis");

  const lines = csv.split(/\r?\n/).slice(1);
  const kubunMap = {};

  for (const line of lines) {
    if (!line.trim()) continue;

    const cols = line.split(",");

    // JSF meigara.csv の列構造:
    // 0: コード
    // 1: 銘柄名
    // 2: 市場
    // 3: 貸借銘柄区分（東証）
    const rawCode = cols[0];
    const kubun = cols[3];

    if (!rawCode) continue;

    const code = rawCode.replace(/\D/g, "").padStart(4, "0");
    kubunMap[code] = kubun;
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

  const current = Array(6).fill(null);
  const rowspanLeft = Array(6).fill(0);

  for (const tr of rows) {
    const tds = [...tr.querySelectorAll("td")];
    if (tds.length === 0) continue;

    const logical = Array(6).fill(null);
    let td_i = 0;

    for (let col = 0; col < 6; col++) {
      if (rowspanLeft[col] > 0) {
        logical[col] = current[col];
        rowspanLeft[col]--;
      }
    }

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

    const code = normalizeCode(rawCode);

    let marketFlag = false;
    if (market) {
      const m = normalizeCode(market);
      marketFlag = TOKYO_KEYWORDS.some(k => m.includes(k));
    }
    if (!marketFlag) continue;

    regulationMap[code] = regulationMap[code] || [];
    regulationMap[code].push(text);
  }

  return { regulationMap, BUY_BAN_KEYWORDS, SELL_BAN_KEYWORDS };
}

// ======================================================================
// 3. JPX 週次 PDF（pdfjs-dist 版・281A0 対応）
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
    s = s.replace(/,/g, "").trim();
    if (s === "" || s === "▲") return 0;
    if (s.startsWith("▲")) return -parseInt(s.slice(1));
    return parseInt(s);
  }

  for (const block of blocks) {
    const m = block.match(/([0-9A-Z]{4}0)\s+JP\d{10}/);
    if (!m) continue;

    const raw5 = m[1];
    const code4 = raw5.slice(0, 4);

    const after = block.split(/JP\d{10}/)[1];
    const nums = (after.match(/[▲\-]?\s*[\d,]+/g) || []).map(parseNum);

    if (nums.length < 4) continue;

    const [sell, sellDiff, buy, buyDiff] = nums;
    const ratio = sell !== 0 ? Math.round((buy / sell) * 100) / 100 : null;

    jpxMap[code4] = { buy, buy_diff: buyDiff, sell, sell_diff: sellDiff, ratio };
  }

  return jpxMap;
}

// ======================================================================
// 4. JPX 日々公表 XLS（281A0 対応）
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

  const latest = links.sort().slice(-1)[0];
  const url = "https://www.jpx.co.jp" + latest;

  const buf = await (await fetch(url)).arrayBuffer();
  const wb = xlsx.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

  const dailyMap = {};

  for (const row of rows) {
    const raw = String(row[0] || "").trim();
    if (!/^[0-9A-Z]{4}0$/.test(raw)) continue;

    const code4 = raw.slice(0, 4);
    const sell = parseInt(String(row[1] || "0").replace(/,/g, ""));
    const buy = parseInt(String(row[2] || "0").replace(/,/g, ""));

    dailyMap[code4] = { sell, buy };
  }

  return dailyMap;
}

// ======================================================================
// 5. margin.json 統合
// ======================================================================
function buildMarginJson(kubunMap, regulationMap, BUY_BAN, SELL_BAN, jpxMap, dailyMap) {
  const margin = {};

  const allCodes = new Set([
    ...Object.keys(kubunMap),
    ...Object.keys(regulationMap),
    ...Object.keys(jpxMap),
    ...Object.keys(dailyMap)
  ]);

  for (const code of allCodes) {
    const kubun = kubunMap[code];

    if (kubun === "0" || kubun == null) continue;

    const regs = regulationMap[code] || [];
    const jpx = jpxMap[code] || {};

    const hasBuyBan = regs.some(r => BUY_BAN.some(k => r.includes(k)));
    const hasSellBan = regs.some(r => SELL_BAN.some(k => r.includes(k)));

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
// 6. バックアップ & 古いバックアップ削除
// ======================================================================
function backupMargin() {
  ensureDir("data/backup");

  const ts = timestamp();
  fs.copyFileSync("data/margin.json", `data/backup/margin.json.${ts}`);
}

function cleanupBackups() {
  const dir = "data/backup";
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
// 7. Main
// ======================================================================
async function main() {
  ensureDir("data");

  const kubunMap = await fetchKubunMap();
  const { regulationMap, BUY_BAN_KEYWORDS, SELL_BAN_KEYWORDS } =
    await fetchRakutenRegulation();
  const jpxMap = await fetchJpxWeekly();
  const dailyMap = await fetchJpxDaily();

  const margin = buildMarginJson(
    kubunMap,
    regulationMap,
    BUY_BAN_KEYWORDS,
    SELL_BAN_KEYWORDS,
    jpxMap,
    dailyMap
  );

  fs.writeFileSync("data/margin.json", JSON.stringify(margin, null, 2), "utf-8");

  backupMargin();
  cleanupBackups();

  console.log("✔ margin.json 更新完了");
}

main();
