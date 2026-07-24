// scripts/lib/yahoo_finance_auth.js
//
// Yahoo Finance の v7/finance/quote 系エンドポイントで必要な crumb（ワンタイムトークン）＋
// セッションCookieの取得ロジック。scripts/fetch.js・scripts/fetch_market_cap.js の双方が
// 完全に同一の手順（fc.yahoo.com → query2.finance.yahoo.com/v1/test/getcrumb）を
// 個別に実装しており、認証方式の変更時に修正漏れが起きるリスクがあったため、
// 2026-07 に本ファイルへ共通化した（conventions.yahooFinanceApiFamilies 参照。
// crumb/Cookie必須化など、非公式API側の認証方式は過去にも予告なく変更された実績がある）。
//
// 2026-07: crumb取得（fc.yahoo.com / getcrumb）へのリクエストがUser-Agent未指定だと
// bot判定を受け、空レスポンス・HTML（チャレンジページ）が返り crumb取得に失敗する事象を
// 確認したため、ブラウザ相当のヘッダーを付与する（Yahoo公式ドキュメントは存在せず、
// コミュニティ報告ベースの対応）。
//
// v8/finance/chart（scripts/fetch.js のフォールバック経路・scripts/heuristics.js）は
// crumb/Cookie/User-Agentのいずれも不要のため、本モジュールの対象外
// （詳細は conventions.yahooFinanceApiFamilies を参照）。
import fetch from "node-fetch";

export const YAHOO_REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
};

function cookieHeaderFrom(setCookieArray) {
  return (setCookieArray || []).map(sc => sc.split(";")[0]).join("; ");
}

/**
 * v7/finance/quote 呼び出しに必要な { crumb, cookie } を取得する。
 * 取得に失敗した場合は null を返す。
 *
 * @param {"ERROR"|"WARNING"} logLevel - 失敗時ログの重大度。
 *   呼び出し元がフォールバックを持つか（WARNING）持たないか（ERROR）で使い分ける
 *   （fetch.js は WARNING、fetch_market_cap.js は ERROR。既存ログ文言の意味を維持するため引数化した）。
 */
export async function getCrumb(logLevel = "WARNING") {
  const cookieRes = await fetch("https://fc.yahoo.com", {
    redirect: "manual",
    headers: YAHOO_REQUEST_HEADERS,
  });
  // node-fetch の Headers#raw() は Set-Cookie を複数持つ場合でも全件配列で返す
  // （Headers#get("set-cookie") だと1件目しか取れず、必要なCookieを取りこぼす）
  const setCookies = cookieRes.headers.raw()["set-cookie"] || [];
  const cookie = cookieHeaderFrom(setCookies);
  if (!cookie) {
    console.log(`${logLevel}: セッションCookieを取得できませんでした。`);
    return null;
  }

  const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { ...YAHOO_REQUEST_HEADERS, Cookie: cookie },
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes("<html") || crumbRes.status !== 200) {
    console.log(`${logLevel}: crumbを取得できませんでした。status=${crumbRes.status} body="${crumb.slice(0, 100)}"`);
    return null;
  }
  return { crumb, cookie };
}
