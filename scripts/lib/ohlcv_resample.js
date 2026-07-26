// scripts/lib/ohlcv_resample.js
//
// 日足OHLCVから週足・月足をローカルで集計するユーティリティ（2026-07 新設）。
//
// Yahoo Finance API（v8/finance/chart）から週足・月足を直接取得すると値が不安定になる
// ことが実運用で確認されたため、日足のみを取得し、週足・月足はバックエンド
// （main.py の /chart エンドポイント）と同一の集計規則でローカル生成するように変更した。
// バックエンド側の実装（pandas）:
//   df.resample("W-FRI").agg({Open:"first",High:"max",Low:"min",Close:"last",Volume:"sum"})
//   df.resample("ME").agg({Open:"first",High:"max",Low:"min",Close:"last",Volume:"sum"})
//
// 集計規則（上記pandas実装と同一。resample の既定 label='right' に対応）:
//   - 週足: 土曜〜金曜を1週とし、その週の金曜日の暦日（実際の取引日か否かは問わない）を
//     代表日（キー）とする。
//   - 月足: 暦月の末日（実際の取引日か否かは問わない）を代表日（キー）とする。
//   - Open=期間内で最初の取引日の始値、High=期間内の最大高値、Low=期間内の最小安値、
//     Close=期間内で最後の取引日の終値、Volume=期間内の合計出来高。
//   - 進行中の週・月（末日がまだ到来していない）も、backendと同様に部分集計として
//     1エントリを生成する（Yahoo Finance側の「進行中の期間」の扱いと同じ）。

function parseYyyymmddUTC(dateStr) {
  const y = parseInt(dateStr.slice(0, 4), 10);
  const m = parseInt(dateStr.slice(4, 6), 10) - 1;
  const d = parseInt(dateStr.slice(6, 8), 10);
  return new Date(Date.UTC(y, m, d));
}

function formatYyyymmddUTC(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** 週の代表日（その週の金曜日、暦日ベース）を返す。土曜始まり・金曜終わりの週。 */
function weekLabel(dateStr) {
  const d = parseYyyymmddUTC(dateStr);
  const dow = d.getUTCDay(); // 0=日,...,5=金,6=土
  const daysUntilFriday = (5 - dow + 7) % 7;
  d.setUTCDate(d.getUTCDate() + daysUntilFriday);
  return formatYyyymmddUTC(d);
}

/** 月の代表日（その月の末日、暦日ベース）を返す。 */
function monthLabel(dateStr) {
  const d = parseYyyymmddUTC(dateStr);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return formatYyyymmddUTC(lastDay);
}

function resampleByLabel(daily, labelFn) {
  const dates = Object.keys(daily).sort(); // YYYYMMDD文字列は辞書順=時系列順
  const buckets = new Map();

  for (const date of dates) {
    const label = labelFn(date);
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(daily[date]);
  }

  const result = {};
  for (const label of [...buckets.keys()].sort()) {
    const bars = buckets.get(label);
    const opens = bars.map(b => b.o).filter(v => v != null);
    const highs = bars.map(b => b.h).filter(v => v != null);
    const lows = bars.map(b => b.l).filter(v => v != null);
    const closes = bars.map(b => b.c).filter(v => v != null);
    const vols = bars.map(b => b.v).filter(v => v != null);

    // pandasの dropna(subset=["Open","Close"]) と同義：Open/Closeが取れないバケットは除外
    if (opens.length === 0 || closes.length === 0) continue;

    result[label] = {
      o: opens[0],
      h: Math.max(...highs),
      l: Math.min(...lows),
      c: closes[closes.length - 1],
      v: vols.reduce((a, b) => a + b, 0),
    };
  }
  return result;
}

/** 日足OHLCV（{YYYYMMDD:{o,h,l,c,v}}）から週足を生成する。 */
export function resampleWeekly(daily) {
  return resampleByLabel(daily, weekLabel);
}

/** 日足OHLCV（{YYYYMMDD:{o,h,l,c,v}}）から月足を生成する。 */
export function resampleMonthly(daily) {
  return resampleByLabel(daily, monthLabel);
}

/**
 * 日足OHLCVのうち、指定日（YYYYMMDD）以前のレコードのみを抽出する。
 * 期間モード（range）で1回だけ取得した長期間の日足を対象日ごとに使い回す際、
 * 対象日より未来のデータが週足・月足の集計に混入する（先読みが発生する）のを防ぐために使う。
 */
export function sliceDailyUpTo(daily, targetDate) {
  const result = {};
  for (const [date, v] of Object.entries(daily)) {
    if (date <= targetDate) result[date] = v;
  }
  return result;
}
