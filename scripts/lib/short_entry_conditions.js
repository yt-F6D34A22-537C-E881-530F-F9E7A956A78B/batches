// 空売りエントリー検出（A-B-C ヘッド・アンド・ショルダーズ・トップ → 50日線での反発失敗）。
// 純粋関数のみ（I/O なし）。入力は日足の配列（古い→新しい）。欠損は NaN/null で表す。
// 各閾値は暫定値。確定値ではないため、analysis.yml 系の検証で調整する前提。

export const SHORT_ENTRY_PARAMS = Object.freeze({
  version: 1,
  maPeriod: 50,              // 50日移動平均線
  headLookbackBars: 120,     // B（天井）を探す範囲（本数）
  minBarsAfterHead: 10,      // 天井から現在まで最低限必要な本数
  baseBars: 20,              // A（直前の支持線）を求める本数
  spikeBars: 5,              // 天井直前の急騰区間（支持線の算出から除外）
  minHeadRise: 0.15,         // 天井高値が支持線より何%以上高いか
  dropMaxBars: 15,           // 天井→②（急落の底）までの最大本数
  minDropFromHead: 0.20,     // 天井→②の下落率の下限
  volumeSpikeMult: 2.0,      // 急落時の出来高が直前50本平均の何倍以上か
  minGapBars: 2,             // 50日線の下に最低何本いたら「別の反発」と数えるか
  entryMinRebounds: 3,       // 反発回数の下限（図：3〜4回）
  entryMaxRebounds: 4,       // 反発回数の上限
  maxOvershoot: 0.10,        // 反発の高値が50日線を上回る幅の上限（真の回復を除外）
  maxAboveBars: 15,          // 50日線の上に居続けてよい最大本数（監視：反発中）
  approachPct: 0.05,         // 50日線の何%下まで「接近」とみなすか
  minBouncePct: 0.03,        // 接近判定：押し目の安値から何%以上戻したか（反発の開始確認）
  splitGuardAbsChange: 0.40, // 1日の終値変化がこれを超える銘柄は分割・併合疑いで除外
});

const isNum = (x) => Number.isFinite(x);

// 単純移動平均（先頭 period-1 本は NaN）。ローリング合計で O(n)。
export function calcSma(values, period) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0, bad = 0;
  for (let i = 0; i < values.length; i++) {
    if (isNum(values[i])) sum += values[i]; else bad++;
    if (i >= period) { if (isNum(values[i - period])) sum -= values[i - period]; else bad--; }
    if (i >= period - 1 && bad === 0) out[i] = sum / period;
  }
  return out;
}

// 銘柄ごとの系列を作る（MA・直前平均出来高を1回だけ前計算し、複数の判定日で使い回す）。
export function buildSeries({ h, l, c, v }, params = SHORT_ENTRY_PARAMS) {
  const ma = calcSma(c, params.maPeriod);
  const volAvgPrev = new Array(v.length).fill(NaN); // 当該足を含まない直前 maPeriod 本の平均
  const volSma = calcSma(v, params.maPeriod);
  for (let i = 1; i < v.length; i++) volAvgPrev[i] = volSma[i - 1];
  return { h, l, c, v, ma, volAvgPrev };
}

const round2 = (x) => Math.round(x * 100) / 100;

// endIdx 時点で「監視」または「エントリー」に該当すれば結果、該当しなければ null。
export function detectShortEntry(s, endIdx, p = SHORT_ENTRY_PARAMS) {
  const { h, l, c, v, ma, volAvgPrev } = s;
  const e = endIdx;
  const winStart = e - p.headLookbackBars - p.baseBars - p.spikeBars;
  if (winStart < 0 || !isNum(ma[e])) return null;

  // 欠損・分割疑いのチェック（ohlcv アーカイブは分割未調整のため）
  for (let i = winStart; i <= e; i++) {
    if (!isNum(h[i]) || !isNum(l[i]) || !isNum(c[i]) || !isNum(v[i]) || c[i] <= 0) return null;
    if (i > winStart && Math.abs(c[i] / c[i - 1] - 1) > p.splitGuardAbsChange) return null;
  }

  // B：天井（直近 headLookbackBars 本のうち、現在から minBarsAfterHead 本以上前の最高値）
  let iB = -1;
  for (let i = e - p.headLookbackBars; i <= e - p.minBarsAfterHead; i++) {
    if (iB < 0 || h[i] >= h[iB]) iB = i;
  }

  // A：直前の支持線（天井の直前 spikeBars 本は急騰区間として除外）
  let support = Infinity;
  for (let i = iB - p.spikeBars - p.baseBars; i < iB - p.spikeBars; i++) support = Math.min(support, l[i]);
  if (h[iB] / support - 1 < p.minHeadRise) return null;

  // ②：急落の底（ネックライン）。支持線割れ・下落率・急落時の大出来高を確認
  const lowEnd = Math.min(iB + p.dropMaxBars, e);
  let iL = iB + 1;
  for (let i = iB + 1; i <= lowEnd; i++) if (l[i] < l[iL]) iL = i;
  const neckline = l[iL];
  const dropRate = (h[iB] - neckline) / h[iB];
  if (neckline >= support || dropRate < p.minDropFromHead) return null;
  let dropVolRatio = 0;
  for (let j = iB + 1; j <= iL; j++) {
    if (c[j] < c[j - 1] && isNum(volAvgPrev[j]) && volAvgPrev[j] > 0) {
      dropVolRatio = Math.max(dropVolRatio, v[j] / volAvgPrev[j]);
    }
  }
  if (dropVolRatio < p.volumeSpikeMult) return null;

  // ネックライン割れ済み（終値ベース）は対象外
  for (let i = iL + 1; i <= e; i++) if (c[i] <= neckline) return null;
  if (!(c[iL] < ma[iL])) return null; // 底は50日線の下

  // 反発の数え上げ：50日線を上抜けた回数。短い押しは同一の反発として統合する
  let state = 'below', belowStreak = p.minGapBars, rebounds = 0, aboveBars = 0, maxOver = 0, dipLow = c[iL];
  for (let i = iL + 1; i <= e; i++) {
    const above = c[i] > ma[i];
    if (state === 'below') {
      if (above) {
        if (belowStreak >= p.minGapBars) { rebounds++; aboveBars = 0; }
        state = 'above';
      } else { belowStreak++; dipLow = Math.min(dipLow, c[i]); }
    } else if (!above) { state = 'below'; belowStreak = 1; dipLow = c[i]; }
    if (state === 'above') { aboveBars++; maxOver = Math.max(maxOver, h[i] / ma[i] - 1); }
  }
  if (maxOver > p.maxOvershoot || rebounds > p.entryMaxRebounds) return null;

  // 段階の判定
  let phase = null;
  if (state === 'below' && belowStreak === 1 &&
      rebounds >= p.entryMinRebounds && rebounds <= p.entryMaxRebounds) {
    phase = 'entry';                                    // 3〜4回目の反発が50日線で失敗した日
  } else if (state === 'above' && aboveBars <= p.maxAboveBars &&
      rebounds >= p.entryMinRebounds && rebounds <= p.entryMaxRebounds) {
    phase = 'rebound';                                  // 監視：3〜4回目の反発中
  } else if (state === 'below' &&
      rebounds >= p.entryMinRebounds - 1 && rebounds <= p.entryMaxRebounds - 1 &&
      belowStreak >= p.minGapBars && c[e] >= ma[e] * (1 - p.approachPct) &&
      c[e] >= dipLow * (1 + p.minBouncePct)) {
    phase = 'approach';                                 // 監視：次の反発が50日線へ接近中
  }
  if (!phase) return null;

  return {
    stage: phase === 'entry' ? 'entry' : 'watch',
    phase,
    reboundCount: rebounds,
    close: round2(c[e]), ma50: round2(ma[e]),
    maGapPct: round2((c[e] / ma[e] - 1) * 100),
    neckline: round2(neckline),
    necklineGapPct: round2((c[e] / neckline - 1) * 100),
    headPrice: round2(h[iB]),
    supportPrice: round2(support),
    dropPct: round2(-dropRate * 100),
    dropVolRatio: round2(dropVolRatio),
    headIdx: iB, lowIdx: iL,
  };
}
