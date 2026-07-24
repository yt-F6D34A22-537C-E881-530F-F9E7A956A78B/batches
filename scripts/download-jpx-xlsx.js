import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { JSDOM } from "jsdom";
import { formatTimestampJst } from "./lib/jst_time.js";
import { backupFile, pruneOlderThanDays } from "./lib/backup_utils.js";

// ---------------------------------------------
// 1. JPX ページから data_j.xls の URL を取得
// ---------------------------------------------
async function getXlsUrl() {
  const url = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html";
  const res = await fetch(url);
  const html = await res.text();

  const dom = new JSDOM(html);
  const document = dom.window.document;

  const anchors = [...document.querySelectorAll("a")];
  const target = anchors.find(a => a.href.includes("data_j.xls"));

  if (!target) {
    throw new Error("data_j.xls のリンクが見つかりませんでした");
  }

  const root = "https://www.jpx.co.jp";
  const link = target.href.startsWith("/") ? root + target.href : target.href;

  return link;
}

// ---------------------------------------------
// 2. data/data_j.xls をダウンロード
// ---------------------------------------------
async function downloadXls(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("data_j.xls のダウンロードに失敗しました");

  const buffer = await res.buffer();

  if (!fs.existsSync("data")) {
    fs.mkdirSync("data", { recursive: true });
  }

  fs.writeFileSync("data/data_j.xls", buffer);
  console.log("✔ data/data_j.xls を保存しました");
}

// ---------------------------------------------
// 3. LibreOffice で XLS → XLSX 変換
// ---------------------------------------------
function convertToXlsx() {
  console.log("✔ LibreOffice で XLS → XLSX 変換中…");

  execSync(
    `libreoffice --headless --convert-to xlsx data/data_j.xls --outdir data`,
    { stdio: "inherit" }
  );

  if (!fs.existsSync("data/data_j.xlsx")) {
    throw new Error("data/data_j.xlsx が生成されませんでした");
  }

  console.log("✔ data/data_j.xlsx を生成しました");
}

// ---------------------------------------------
// 4. バックアップ作成（data/backup）
// ---------------------------------------------
function backupFiles() {
  const backupDir = "data/backup";
  // xls・xlsxの2ファイルを同一タイムスタンプでまとめてバックアップする（既存挙動を維持）
  const ts = formatTimestampJst();

  const dstXls = backupFile("data/data_j.xls", backupDir, ts);
  const dstXlsx = backupFile("data/data_j.xlsx", backupDir, ts);

  console.log("✔ バックアップ作成:", dstXls, dstXlsx);
}

// ---------------------------------------------
// 5. 古いバックアップ削除（3日以上）
// ---------------------------------------------
function cleanupBackups() {
  pruneOlderThanDays("data/backup", /(data_j\.(xls|xlsx))\.(\d{8}_\d{6})$/, 3);
}

// ---------------------------------------------
// 6. メイン処理
// ---------------------------------------------
async function main() {
  try {
    const url = await getXlsUrl();
    console.log("✔ XLS URL:", url);

    await downloadXls(url);
    convertToXlsx();
    backupFiles();
    cleanupBackups();

    console.log("✔ JPX data_j.xlsx 更新完了");

  } catch (err) {
    console.error("ERROR:", err);
    process.exit(1);
  }
}

main();
