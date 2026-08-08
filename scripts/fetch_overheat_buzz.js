import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { JSDOM } from "jsdom";
import { formatTimestampJst } from "./lib/jst_time.js";
import { backupFile, pruneOlderThanDays } from "./lib/backup_utils.js";

// [2026-08-08 新規追加] TECH_OVERHEAT の「SNS/ニュースでの話題性」条件を実装するため、
// SNS話題株サイト（トレーダーウォッチ / wolf-fun.secret.jp）の「話題株ランキング」
// ページをスクレイピングし、当日ランキングに掲載されている銘柄コードの一覧を
// data/overheat_buzz/overheat_buzz_YYYYMMDD.json として日次アーカイブする。
// heuristics.js から呼ばれる runAllConditions() は、このファイルを読み込んで
// 「銘柄コードがランキングに載っているか（0/1）」を isOverheat の話題性条件に使う。
// download-jpx-xlsx.js と同じ構成（node-fetch + JSDOM でのスクレイピング、
// lib/jst_time.js・lib/backup_utils.js を使ったバックアップ）を踏襲している。
//
// 注意：スクレイピング対象サイトのHTML構造は、要約されたページ内容からの推測で
// セレクタを設計しており、実際の生HTMLでの検証は行っていない。初回実行時は
// 必ず生成された data/overheat_buzz/overheat_buzz_YYYYMMDD.json の中身
// （codes配列が妥当か）を目視確認すること。

const RANKING_URL = "https://wolf-fun.secret.jp/?%E8%A9%B1%E9%A1%8C%E6%A0%AA%E3%83%A9%E3%83%B3%E3%82%AD%E3%83%B3%E3%82%B0"; // 話題株ランキング

// ---------------------------------------------
// 1. 話題株ランキングページを取得
// ---------------------------------------------
async function fetchRankingHtml() {
  const res = await fetch(RANKING_URL);
  if (!res.ok) {
    throw new Error(`ランキングページの取得に失敗しました: HTTP ${res.status}`);
  }
  return await res.text();
}

// ---------------------------------------------
// 2. 銘柄コードを抽出（掲載されていれば話題あり=1）
// ---------------------------------------------
function parseTopicalCodes(html) {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const anchors = [...document.querySelectorAll("a[href*='cmd=stock_detail']")];
  const codes = new Set();

  for (const a of anchors) {
    const match = a.href.match(/code=([0-9A-Za-z]{4,5})/);
    if (match) codes.add(match[1]);
  }

  return [...codes];
}

// ---------------------------------------------
// 3. data/overheat_buzz/overheat_buzz_YYYYMMDD.json を保存
// ---------------------------------------------
function saveTopicalCodes(codes) {
  const outputDir = "data/overheat_buzz";
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const now = new Date();
  const date =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");

  const outputPath = path.join(outputDir, `overheat_buzz_${date}.json`);

  const record = {
    date,
    source: RANKING_URL,
    scrapedAt: now.toISOString(),
    codes, // このランキングに掲載されている＝話題あり(1)。それ以外は話題なし(0)扱い
  };

  fs.writeFileSync(outputPath, JSON.stringify(record, null, 2));
  console.log(`✔ ${outputPath} を保存しました（${codes.length}銘柄）`);

  return outputPath;
}

// ---------------------------------------------
// 4. バックアップ作成（data/backup）
// ---------------------------------------------
function backupFiles(outputPath) {
  const backupDir = "data/backup";
  const ts = formatTimestampJst();
  const dst = backupFile(outputPath, backupDir, ts);
  console.log("✔ バックアップ作成:", dst);
}

// ---------------------------------------------
// 5. 古いバックアップ削除（3日以上、download-jpx-xlsx.jsと同じ保持期間）
// ---------------------------------------------
function cleanupBackups() {
  pruneOlderThanDays("data/backup", /(overheat_buzz_\d{8}\.json)\.(\d{8}_\d{6})$/, 3);
}

// ---------------------------------------------
// 6. メイン処理
// ---------------------------------------------
async function main() {
  try {
    const html = await fetchRankingHtml();
    const codes = parseTopicalCodes(html);

    if (codes.length === 0) {
      // 構造変化等でパースに失敗した場合、空ファイルで上書きせず異常終了させる
      throw new Error("銘柄コードを1件も取得できませんでした（HTML構造が変わった可能性）");
    }

    const outputPath = saveTopicalCodes(codes);
    backupFiles(outputPath);
    cleanupBackups();

    console.log("✔ overheat_buzz 更新完了");

  } catch (err) {
    console.error("ERROR:", err);
    process.exit(1);
  }
}

main();
