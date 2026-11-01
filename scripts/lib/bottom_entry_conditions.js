// 買い目線の下げ止まり検出（投げ売り → 2番底／3番底の確認）。
// 純粋関数のみ（I/O なし）。入力は日足の配列（古い→新しい）。欠損は NaN/null で表す。
// 各閾値は暫定値。確定値ではないため、実データでの確認・検証を経て調整する前提。
//
// 【画面から指定できる条件】
//   下の「★」を付けた4つの閾値は、アーカイブ生成時は「緩い下限」として使い、各候補の指標値
//   （dropPct / climaxRatio / climaxDropPct / retestVolRatio）を結果に保存する。
//   画面の条件（より厳しい値）は、バックエンドがこの指標値で絞り込む。絞り込み後の結果は、
//   その閾値で最初から検出し直した結果と一致する（これらの閾値は「通過／除外」の判定にだけ使い、
//   他の計算に影響しないため）。したがって、画面で指定できるのは「生成時の下限より厳しい値」のみ。

export const BOTTOM_ENTRY_PARAMS = Object.freeze({
  version: 2,                // v2：画面条件の絞り込み用に指標値を追加、★の閾値を緩い下限へ変更
  volAvgPeriod: 50,          // 出来高の比較基準（直前の平均出来高の本数）
  highLookbackBars: 120,     // 下落前の高値を探す範囲（本数）
  bottomLookbackBars: 60,    // 投げ売り（第1底）を探す範囲（本数）
  minBarsAfterClimax: 6,     // 投げ売り日から判定日までに最低限必要な本数
  climaxPad: 2,              // 投げ売り日の前後何本から第1底の安値を求めるか
  minDropFromHigh: 0.15,     // ★高値から第1底までの下落率の下限（要件：−15%以上。これより緩い指定は不可）
  climaxDropBars: 5,         // 投げ売りの急落を見る本数（第1底から遡って何本の高値と比べるか）
  climaxMinDrop: 0.05,       // ★投げ売り直前の急落：直近 climaxDropBars 本の高値から第1底までの下落率の下限
  volumeSpikeMult: 2.0,      // ★投げ売り日の出来高が、直前50本の平均出来高の何倍以上か
  undercutTol: 0.03,         // 第1底を終値で何割割ったら「底割れ」とするか（対象外）
  retestUpperTol: 0.08,      // 底の再テスト圏の上限（第1底の何割上まで。上限値）
  zoneFracOfDrop: 0.25,      // 底の再テスト圏の上限（下落幅〔高値−第1底〕の何割まで。retestUpperTol との小さい方を採用）
  reboundFracOfDrop: 0.45,   // 再テスト前の反発：下落幅の何割以上を戻している必要があるか（再テスト圏の上限を必ず超えるよう補正する）
  minGapBars: 3,             // 前の底から次の底のテスト開始までの最低本数
  confirmBouncePct: 0.03,    // 底の確認：再テストの安値から何割以上戻したか（終値）
  maxRetestBars: 15,         // 再テスト圏に居続けてよい最大本数（超えたら対象外）
  maxChasePct: 0.10,         // 確認日の終値が再テスト安値を何割まで上回ってよいか（飛びつき防止）
  retestVolMaxRatio: 0.8,    // ★再テスト時の出来高が、投げ売り日の出来高の何割以下か（出来高の枯れ）
  maxTouches: 2,             // 再テストの最大回数（2＝2番底・3番底まで）
  approachPct: 0.12,         // 監視（接近）：第1底の何割上以内まで下がってきたか
  splitGuardAbsChange: 0.40, // 1日の終値変化がこれを超える銘柄は分割・併合疑いとして除外
});

const isNum = (x) => Number.isFinite(x);
const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;   // 画面条件で絞り込む指標値は、境界付近のずれを避けるため小数4桁で保存する

/** 判定に必要な過去の本数（これ未満の履歴しかない日付は判定しない） */
export const requiredBars = (p = BOTTOM_ENTRY_PARAMS) =>
  Math.max(p.highLookbackBars, p.bottomLookbackBars + p.volAvgPeriod);

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

// 銘柄ごとの系列を作る（直前平均出来高を1回だけ前計算し、複数の判定日で使い回す）。
export function buildSeries({ h, l, c, v }, params = BOTTOM_ENTRY_PARAMS) {
  const volSma = calcSma(v, params.volAvgPeriod);
  const volAvgPrev = new Array(v.length).fill(NaN); // 当該足を含まない直前 volAvgPeriod 本の平均
  for (let i = 1; i < v.length; i++) volAvgPrev[i] = volSma[i - 1];
  return { h, l, c, v, volAvgPrev };
}

// endIdx 時点で「監視」または「エントリー」に該当すれば結果、該当しなければ null。
export function detectBottomEntry(s, endIdx, p = BOTTOM_ENTRY_PARAMS) {
  const { h, l, c, v, volAvgPrev } = s;
  const e = endIdx;
  const winStart = e - requiredBars(p);
  if (winStart < 0) return null;

  // 欠損・分割疑いのチェック（ohlcv アーカイブは分割未調整のため）
  for (let i = winStart; i <= e; i++) {
    if (!isNum(h[i]) || !isNum(l[i]) || !isNum(c[i]) || !isNum(v[i]) || c[i] <= 0) return null;
    if (i > winStart && Math.abs(c[i] / c[i - 1] - 1) > p.splitGuardAbsChange) return null;
  }

  // 1) 投げ売り日：安値圏（窓内最安値の undercutTol 以内）で起きた、出来高比が最大の日
  const bStart = e - p.bottomLookbackBars;
  let windowMin = Infinity;
  for (let i = bStart; i <= e; i++) windowMin = Math.min(windowMin, l[i]);
  let jc = -1, climaxRatio = 0;
  for (let j = bStart; j <= e - p.minBarsAfterClimax; j++) {
    if (!isNum(volAvgPrev[j]) || volAvgPrev[j] <= 0) continue;
    const ratio = v[j] / volAvgPrev[j];
    if (ratio < p.volumeSpikeMult || ratio <= climaxRatio) continue;
    let padLow = Infinity;
    for (let k = j - p.climaxPad; k <= Math.min(e, j + p.climaxPad); k++) padLow = Math.min(padLow, l[k]);
    if (padLow > windowMin * (1 + p.undercutTol)) continue;
    jc = j; climaxRatio = ratio;
  }
  if (jc < 0) return null;

  // 2) 第1底（投げ売り安値）：投げ売り日の前後 climaxPad 本の安値の最小
  let iL1 = jc;
  for (let k = jc - p.climaxPad; k <= Math.min(e, jc + p.climaxPad); k++) if (l[k] < l[iL1]) iL1 = k;
  const firstLow = l[iL1];

  // 投げ売りは「急落を伴う」：第1底の直前 climaxDropBars 本の高値から、第1底まで climaxMinDrop 以上下げていること
  let recentHigh = -Infinity;
  for (let i = Math.max(winStart, iL1 - p.climaxDropBars); i <= iL1; i++) recentHigh = Math.max(recentHigh, h[i]);
  const climaxDrop = (recentHigh - firstLow) / recentHigh;
  if (climaxDrop < p.climaxMinDrop) return null;

  // 3) 下落前の高値と下落率
  let iH = e - p.highLookbackBars;
  for (let i = iH; i <= iL1; i++) if (h[i] >= h[iH]) iH = i;
  const dropRate = (h[iH] - firstLow) / h[iH];
  if (dropRate < p.minDropFromHigh) return null;

  // 4) 第1底以降の値動きを走査し、2番底・3番底の「再テスト」を数える
  //    再テスト圏・必要な反発幅は下落幅に比例させる（−15%程度の浅い押し目でも、深い下落でも同じ考え方で判定するため）
  const range = h[iH] - firstLow;
  const zoneUpper = firstLow + Math.min(p.retestUpperTol * firstLow, p.zoneFracOfDrop * range);
  const breakLevel = firstLow * (1 - p.undercutTol);
  const reboundLevel = Math.max(firstLow + p.reboundFracOfDrop * range, zoneUpper * 1.03);
  const climaxVol = v[jc];
  // 再テスト安値の前後1本の出来高の最大 ÷ 投げ売り日の出来高（出来高の枯れの指標）
  const retestVolRatioAt = (idx, upTo) => Math.max(v[idx - 1], v[idx], v[Math.min(upTo, idx + 1)]) / climaxVol;

  let touches = 0, active = false, retestStart = -1, retestLow = Infinity, retestLowIdx = -1;
  let lastBottomIdx = iL1, peak = -Infinity, confirmIdx = -1, retestVolMax = 0;
  for (let i = iL1 + 1; i <= e; i++) {
    if (c[i] < breakLevel) return null;                         // 底割れ（支持の失敗）
    if (!active) {
      peak = Math.max(peak, h[i]);
      // 反発（reboundLevel 以上）を経て、再び再テスト圏に入ったら、次の底のテスト開始
      if (peak >= reboundLevel && l[i] <= zoneUpper && i - lastBottomIdx >= p.minGapBars) {
        if (touches >= p.maxTouches) return null;              // 4番底以降は対象外
        active = true; touches++; retestStart = i; retestLow = l[i]; retestLowIdx = i;
      }
    } else {
      if (l[i] < retestLow) { retestLow = l[i]; retestLowIdx = i; }
      if (c[i] >= retestLow * (1 + p.confirmBouncePct)) {       // 底の確認（反発の確認）
        const vr = retestVolRatioAt(retestLowIdx, i);
        if (vr > p.retestVolMaxRatio) return null;              // 出来高が枯れていない
        retestVolMax = Math.max(retestVolMax, vr);
        active = false; lastBottomIdx = retestLowIdx; peak = h[i]; confirmIdx = i;
      } else if (i - retestStart > p.maxRetestBars) {
        return null;                                            // 長引くもみ合いは対象外
      }
    }
  }
  if (active) {
    const vr = retestVolRatioAt(retestLowIdx, e);
    if (vr > p.retestVolMaxRatio) return null;
    retestVolMax = Math.max(retestVolMax, vr);
  }

  // 5) 局面の判定
  let phase = null, bottomNo = null;
  if (active) {
    phase = 'retest'; bottomNo = touches + 1;                   // 監視：N番底の確認中
  } else if (confirmIdx === e) {
    if (c[e] <= retestLow * (1 + p.maxChasePct)) { phase = 'entry'; bottomNo = touches + 1; } // エントリー：底の確認完了
  } else if (touches < p.maxTouches && peak >= reboundLevel && c[e] <= firstLow * (1 + p.approachPct) &&
             c[e] < c[e - 1] && c[e - 1] < c[e - 2]) {
    phase = 'approach'; bottomNo = touches + 2;                 // 監視：次の底へ接近
  }
  if (!phase) return null;

  let neckline = -Infinity;
  for (let i = iL1; i <= e; i++) neckline = Math.max(neckline, h[i]);
  const hasRetest = touches >= 1;
  return {
    stage: phase === 'entry' ? 'entry' : 'watch',
    phase,
    bottomNo,
    close: round2(c[e]),
    firstLow: round2(firstLow),
    firstLowGapPct: round2((c[e] / firstLow - 1) * 100),
    retestLow: hasRetest ? round2(retestLow) : null,
    highPrice: round2(h[iH]),
    dropPct: round4(-dropRate * 100),
    climaxRatio: round4(climaxRatio),
    climaxDropPct: round4(-climaxDrop * 100),
    retestVolRatio: hasRetest ? round4(retestVolMax) : null,   // これまでの再テストの出来高比の最大値
    neckline: round2(neckline),
    necklineGapPct: round2((c[e] / neckline - 1) * 100),
    highIdx: iH, climaxIdx: jc, lowIdx: iL1, retestLowIdx: hasRetest ? retestLowIdx : null,
  };
}
