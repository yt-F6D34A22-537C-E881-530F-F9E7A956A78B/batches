// scripts/lib/backup_utils.js
//
// data/backup/ 配下へのバックアップ作成・古いバックアップの削除ロジック。
// fetch.js・margin.js・download-jpx-xlsx.js・heuristics.js が同種の処理
// （タイムスタンプ付きコピーの作成／古いバックアップの削除）を個別に実装していたため、
// 2026-07 に共通化した。
//
// 削除ポリシーは既存実装のまま2種類を維持している（統合していない）:
//   - pruneKeepNewest   : 件数ベース（新しいN件だけ残す。fetch.js・heuristics.jsが使用）
//   - pruneOlderThanDays: 日数ベース（N日より古いものを削除。margin.js・download-jpx-xlsx.jsが使用）
// 挙動を統一すると各スクリプトの既存運用（バックアップ保持方針）が変わってしまうため、
// 既存の使い分けをそのまま踏襲している。
import fs from "fs";
import path from "path";
import { formatTimestampJst, jstNow } from "./jst_time.js";

/**
 * 指定ファイルを <backupDir>/<basename>.<YYYYMMDD_HHMMSS>（JST）としてコピーする。
 * @param {string} [ts] - タイムスタンプ文字列を明示指定する場合（省略時は呼び出し時点のJST時刻）。
 *   download-jpx-xlsx.js のように複数ファイルをまとめて同一タイムスタンプでバックアップしたい場合に使う。
 * @returns {string} 作成したバックアップファイルのパス
 */
export function backupFile(filePath, backupDir, ts = formatTimestampJst()) {
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, `${path.basename(filePath)}.${ts}`);
  fs.copyFileSync(filePath, dest);
  return dest;
}

/**
 * backupDir配下のうち filterFn を満たすファイルを名前順（≒タイムスタンプ順）にソートし、
 * 新しい keepCount 件だけ残して古いものを削除する。
 */
export function pruneKeepNewest(backupDir, filterFn, keepCount) {
  if (!fs.existsSync(backupDir)) return;
  const files = fs.readdirSync(backupDir).filter(filterFn).sort();
  while (files.length > keepCount) {
    fs.unlinkSync(path.join(backupDir, files.shift()));
  }
}

/**
 * backupDir配下のうち正規表現patternにマッチするファイルについて、
 * pattern内の最後のキャプチャグループ（'YYYYMMDD_HHMMSS'形式のタイムスタンプ）を読み取り、
 * 現在時刻（JST）からdays日より古いものを削除する。
 */
export function pruneOlderThanDays(backupDir, pattern, days) {
  if (!fs.existsSync(backupDir)) return;
  const files = fs.readdirSync(backupDir);
  const now = jstNow();

  for (const f of files) {
    const m = f.match(pattern);
    if (!m) continue;

    const ts = m[m.length - 1]; // 'YYYYMMDD_HHMMSS'（patternの最後のキャプチャグループ）
    const dt = new Date(
      Number(ts.slice(0, 4)),
      Number(ts.slice(4, 6)) - 1,
      Number(ts.slice(6, 8)),
      Number(ts.slice(9, 11)),
      Number(ts.slice(11, 13)),
      Number(ts.slice(13, 15))
    );

    const diffDays = (now - dt) / (1000 * 60 * 60 * 24);
    if (diffDays > days) {
      fs.unlinkSync(path.join(backupDir, f));
    }
  }
}
