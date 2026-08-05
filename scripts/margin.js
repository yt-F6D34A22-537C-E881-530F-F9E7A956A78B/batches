import fetch from "node-fetch";
import fs from "fs";
import xlsx from "xlsx";
import { JSDOM } from "jsdom";
import iconv from "iconv-lite";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { formatTimestampJst } from "./lib/jst_time.js";
import { backupFile, pruneOlderThanDays } from "./lib/backup_utils.js";

// ============================================================
// Utility
// ============================================================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// jstNow・timestampは共通化のため scripts/lib/jst_time.js（formatTimestampJst）へ移動した（2026-07）。

function normalizeNFKC(s) {
  return s.normalize("NFKC");
}

// margin_archive のファイル名（YYYYMMDD）に使うJST日付。
// formatTimestampJst() は "YYYYMMDD_hhmmss" 形式（data/backup のファイル名で使用中）を返すため、
// 先頭8文字を流用する。jst_time.js への新規export追加は不要（2026-08追加）。
function todayDateStrJst() {
  return formatTimestampJst(new Date()).slice(0, 8);
}

// ============================================================
// 基準日抽出（margin_archive のmeta用。2026-08追加）
//   - JPX側の各公表資料に記載されている「その資料が何の日付時点のデータか」を
//     抽出する。抽出できない場合は null を返し、warnログのみ出して処理は継続する
//     （JPX側の資料形式変更等で壊れても、信用残データ本体の取得自体は止めない）。
// ============================================================

// syumatsu*.pdf の全文テキストから「YYYY/M/D 申込み現在」を抽出する
function extractWeeklyBaseDate(fullText) {
  const m = fullText.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*申込み現在/);
  if (!m) {
    console.warn("[margin_archive] weekly base date pattern not found in PDF text");
    return null;
  }
  const [, y, mo, d] = m;
  return `${y}${mo.padStart(2, "0")}${d.padStart(2, "0")}`;
}

// meigara.csv の1行目（貸借取引対象銘柄一覧,YYYYMMDD,...）から基準日を抽出する
function extractKubunBaseDate(csv) {
  const firstLine = csv.split(/\r?\n/)[0];
  const cols = firstLine.split(",");
  if (!cols[1]) {
    console.warn("[margin_archive] kubun base date not found in meigara.csv header");
    return null;
  }
  return cols[1];
}

// mtdailyk*.xls の生シートから「as of YYYY/M/D application based」を抽出する（B2セル想定）
function extractDailyBaseDate(sheet) {
  const cellAddr = xlsx.utils.encode_cell({ r: 1, c: 1 }); // "B2"
  const cell = sheet[cellAddr];
  if (!cell || typeof cell.v !== "string") {
    console.warn(`[margin_archive] daily base date cell not found or unexpected format: ${cellAddr}`);
    return null;
  }
  const m = cell.v.match(/as of (\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) {
    console.warn(`[margin_archive] daily base date pattern mismatch: "${cell.v}"`);
    return null;
  }
  const [, y, mo, d] = m;
  return `${y}${mo.padStart(2, "0")}${d.padStart(2, "0")}`;
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

  // margin_archive のmeta用に基準日を抽出しておく（2026-08追加。margin.json 本体には影響しない）
  const baseDate = extractKubunBaseDate(csv);

  const lines = csv.split(/\r?\n/);
  if (lines.length < 3) return { kubunMap: {}, baseDate };

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

  return { kubunMap, baseDate };
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

    // 市場フィルタ
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

  if (pdfLinks.length === 0) return { jpxMap: {}, baseDate: null };

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

  // margin_archive のmeta用に基準日を抽出しておく（2026-08追加。margin.json 本体には影響しない）
  const baseDate = extractWeeklyBaseDate(fullText);

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

  return { jpxMap, baseDate };
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

  if (links.length === 0) return { dailyMap: {}, baseDate: null };

  const latestDaily = links.sort().slice(-1)[0];
  const dailyUrl = "https://www.jpx.co.jp" + latestDaily;

  const buf = await (await fetch(dailyUrl)).arrayBuffer();
  const wb = xlsx.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];

  // margin_archive のmeta用に基準日を抽出しておく（2026-08追加。margin.json 本体には影響しない）
  const baseDate = extractDailyBaseDate(sheet);

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

  return { dailyMap, baseDate };
}

// ============================================================
// 5. 日々公表で週次を上書き
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
// 7. バックアップ作成
// ============================================================
function backupMargin() {
  backupFile("data/margin.json", "data/backup");
}

// ============================================================
// 8. 古いバックアップ削除（3日超）
// ============================================================
function cleanupBackups() {
  pruneOlderThanDays("data/backup", /margin\.json\.(\d{8}_\d{6})$/, 3);
}

// ============================================================
// 8.5. margin_archive 書き出し（信用残アーカイブ化。2026-08追加）
//   - data/ohlcv・data/heuristics と同じ「1ファイル＝1日分・恒久保存・
//     一度書いたら不変」方針。margin.yml は1日1回実行のため、
//     同日中の再実行（workflow_dispatch再実行等）で当日分ファイルが
//     既に存在する場合は上書きせずスキップする。
//   - margin.json と同一内容（全項目）に、各銘柄が「その日、日々公表対象
//     だったか」を示す「情報源」フィールドを付与して保存する。
//   - ファイル単位のmetaとして、各データソース（週次PDF・日々公表XLS・
//     JSF貸借銘柄CSV）の基準日を記録する。これにより「情報源: 通常公表」
//     の銘柄が実際にいつ時点の値を繰り越しているかを、後からチャート等で
//     機械的に判定できる。
// ============================================================
const MARGIN_ARCHIVE_DIR = "data/margin";

/**
 * margin.json と同一内容に「情報源」（日々公表 / 通常公表）を付与した
 * アーカイブ専用レコードを構築する。margin.json のスキーマ・値には
 * 一切影響しない（アーカイブ書き出し時にのみ複製して付与）。
 */
function buildArchiveRecord(entry, isDailyDisclosed) {
  return {
    ...entry,
    "情報源": isDailyDisclosed ? "日々公表" : "通常公表",
  };
}

/**
 * @param {object} margin - margin.json と同一内容（全項目）
 * @param {Set<string>} dailyDisclosedCodes - その実行でJPX日々公表(dailyMap)に含まれていた銘柄コード集合
 * @param {object} meta - 基準日情報
 * @param {string|null} meta.jpxWeeklyBaseDate - syumatsu*.pdf の基準日（YYYYMMDD）
 * @param {string|null} meta.kubunBaseDate - meigara.csv の基準日（YYYYMMDD）
 * @param {string|null} meta.jpxDailyBaseDate - mtdailyk*.xls の基準日（YYYYMMDD）
 */
function writeMarginArchive(margin, dailyDisclosedCodes, meta) {
  const dateStr = todayDateStrJst();
  const yyyymm = dateStr.slice(0, 6);
  const dir = `${MARGIN_ARCHIVE_DIR}/${yyyymm}`;
  const filePath = `${dir}/margin_${dateStr}.json`;

  if (fs.existsSync(filePath)) {
    console.log(`[margin_archive] skip (already exists, immutable): ${filePath}`);
    return;
  }

  const issues = {};
  for (const [code, entry] of Object.entries(margin)) {
    issues[code] = buildArchiveRecord(entry, dailyDisclosedCodes.has(code));
  }

  const archive = {
    meta: {
      jpx_weekly_base_date: meta.jpxWeeklyBaseDate,
      kubun_base_date: meta.kubunBaseDate,
      jpx_daily_base_date: meta.jpxDailyBaseDate,
    },
    issues,
  };

  ensureDir(dir);
  fs.writeFileSync(filePath, JSON.stringify(archive, null, 2), "utf-8");
  console.log(`[margin_archive] wrote: ${filePath}`);
}

// ============================================================
// 9. Main
// ============================================================
async function main() {
  ensureDir("data");

  const { kubunMap, baseDate: kubunBaseDate } = await fetchKubunMap();
  const { regulationMap, BUY_BAN_KEYWORDS, SELL_BAN_KEYWORDS } =
    await fetchRakutenRegulation();
  const { jpxMap, baseDate: jpxWeeklyBaseDate } = await fetchJpxWeekly();
  const { dailyMap, baseDate: jpxDailyBaseDate } = await fetchJpxDaily();

  // この実行で日々公表XLSに実際に載っていた銘柄コード集合。
  // 将来の信用残推移チャートで「日々公表由来の値」と「週次PDFの値が
  // そのまま残っている（未更新）値」を点ごとに区別するために保持する
  // （2026-08追加。margin.json 本体のスキーマには影響させない）。
  const dailyDisclosedCodes = new Set(Object.keys(dailyMap));

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

  fs.writeFileSync("data/margin.json", JSON.stringify(sorted, null, 2), "utf-8");

  backupMargin();
  cleanupBackups();

  // 信用残アーカイブ化（2026-08追加）。margin.json と同じ内容（全項目）を
  // 日付ごとの恒久ファイルとして保存する。
  writeMarginArchive(sorted, dailyDisclosedCodes, {
    jpxWeeklyBaseDate,
    kubunBaseDate,
    jpxDailyBaseDate,
  });
}

main();
