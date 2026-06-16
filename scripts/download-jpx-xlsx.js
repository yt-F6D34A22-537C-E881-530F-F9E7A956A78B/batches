import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { JSDOM } from "jsdom";

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
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // JST
  const pad = n => String(n).padStart(2, "0");

  const timestamp =
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) + "_" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds());

  const srcXls = "data/data_j.xls";
  const srcXlsx = "data/data_j.xlsx";

  const dstXls = path.join(backupDir, `data_j.xls.${timestamp}`);
  const dstXlsx = path.join(backupDir, `data_j.xlsx.${timestamp}`);

  fs.copyFileSync(srcXls, dstXls);
  fs.copyFileSync(srcXlsx, dstXlsx);

  console.log("✔ バックアップ作成:", dstXls, dstXlsx);
}

// ---------------------------------------------
// 5. 古いバックアップ削除（3日以上）
// ---------------------------------------------
function cleanupBackups() {
  const backupDir = "data/backup";
  const files = fs.readdirSync(backupDir);

  const pattern = /(data_j\.(xls|xlsx))\.(\d{8}_\d{6})$/;

  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // JST

  for (const file of files) {
    const match = file.match(pattern);
    if (!match) continue;

    const timestamp = match[3];
    const dt = new Date(
      Number(timestamp.slice(0, 4)),
      Number(timestamp.slice(4, 6)) - 1,
      Number(timestamp.slice(6, 8)),
      Number(timestamp.slice(9, 11)),
      Number(timestamp.slice(11, 13)),
      Number(timestamp.slice(13, 15))
    );

    const diff = now - dt;
    const days = diff / (1000 * 60 * 60 * 24);

    if (days > 3) {
      const fullPath = path.join(backupDir, file);
      fs.unlinkSync(fullPath);
      console.log("✔ 古いバックアップ削除:", fullPath);
    }
  }
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
