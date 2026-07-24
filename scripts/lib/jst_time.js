// scripts/lib/jst_time.js
//
// JST（日本時間）基準の日時ユーティリティ。
// fetch.js・margin.js・download-jpx-xlsx.js・heuristics.js が
// それぞれ個別に同一のロジック（UTC時刻に9時間加算してJSTを模擬 + ゼロ埋め）を
// 実装しており、修正のたびに4箇所を揃える必要があったため、2026-07 に共通化した。
//
// Node.jsのTZ設定に依存させないよう、従来通り「UTC時刻に9時間加算したDateオブジェクトに対し
// ローカルタイムゲッター（getFullYear等）を呼ぶ」簡易的な方式を踏襲している
// （GitHub Actions（ubuntu-latest）のデフォルトTZ=UTCであることを前提とした、
// 各呼び出し元の既存実装からの移植。厳密なタイムゾーン変換ライブラリは使用しない）。

export function jstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

/** YYYYMMDD 形式（JST） */
export function formatDateJst(d = jstNow()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** YYYYMMDD_HHMMSS 形式（JST。バックアップファイル名等に使用） */
export function formatTimestampJst(d = jstNow()) {
  return `${formatDateJst(d)}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
