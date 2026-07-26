// scripts/lib/concurrency.js
//
// 同時実行数を制限したプール処理ユーティリティ。
// heuristics.js の全銘柄の日足取得のように、多数の非同期タスク
// （Yahoo Finance APIへのリクエスト等）を、外部APIのレート制限に配慮しつつ
// 並列に処理したい場合に使う（2026-07 新設）。
//
// 外部ライブラリ（p-limit等）を追加せず、シンプルなワーカープール方式で実装している。

/**
 * items の各要素に対して worker(item, index) を、同時実行数 limit を超えないように
 * 並列実行し、結果を items と同じ順序の配列で返す。
 *
 * @param {Array} items
 * @param {number} limit - 同時実行数の上限
 * @param {(item: any, index: number) => Promise<any>} worker
 * @returns {Promise<Array>}
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current], current);
    }
  }

  const poolSize = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: poolSize }, () => runNext());
  await Promise.all(workers);

  return results;
}
