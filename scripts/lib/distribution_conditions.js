/**
 * distribution_conditions.js
 *
 * 売り抜け（大口の分配）の確認サイン検出ロジック。
 * 「高値圏まで上昇した銘柄に、出来高を伴う大陰線が出現した日」を判定する。
 * 純粋関数のみ（外部通信・ファイルI/Oなし）。scripts/distribution.js からのみ import される。
 * 入力は日足の配列（古い→新しい。欠損は NaN/null）。
 *
 * 注意：日足OHLCVからは「誰が売ったか」は判別できない。本ロジックは
 * 「売り抜けが行われた可能性が高い値動き」の候補抽出であり、確定判定ではない。
 */

/**
 * 判定パラメータ。いずれも暫定値。変更する場合は version を上げ、
 * 既存アーカイブを range モードで再生成する。
 * ★は画面のスクリーニング条件から指定できる閾値で、アーカイブ生成時は
 * 「緩い下限」として使う（bottom_entry と同じ方式）。
 */
export const DISTRIBUTION_PARAMS = Object.freeze({
  version: 1,
  volAvgPeriod: 50,        // 出来高の比較基準とする直前の平均出来高の本数
  trendLookbackBars: 60,   // 直近高値・直前の上昇を調べる範囲（本数。判定日を含まない）
  minVolumeMult: 1.5,      // ★判定日の出来高が直前平均の何倍以上か
  minBodyPct: 0.02,        // ★実体下落率 (始値−終値)/始値 の下限（大陰線）
  minBodyRatio: 0.5,       // 実体が当日値幅(高値−安値)に占める割合の下限（長い下ヒゲの陰線を除く）
  nearHighTol: 0.20,       // ★前日終値が直近高値の何割以内か（高値圏）
  minRise: 0.10,           // ★直近高値までの上昇率（高値/その前の安値−1）の下限
  splitGuardAbsChange: 0.40, // 1日の終値変化がこれを超える銘柄は分割・併合疑いとして除外
});

/** 判定に必要な過去の本数。 */
export function requiredBars(params = DISTRIBUTION_PARAMS) {
  return Math.max(params.volAvgPeriod, params.trendLookbackBars);
}

/** 銘柄ごとの系列を作る（当該足を含まない直前 volAvgPeriod 本の平均出来高を前計算）。 */
export function buildSeries({ o, h, l, c, v }, params = DISTRIBUTION_PARAMS) {
  const n = v.length;
  const volAvgPrev = new Float64Array(n).fill(NaN);
  const p = params.volAvgPeriod;
  let sum = 0;
  let bad = 0; // 窓内の非有限値の数
  for (let i = 0; i < n; i++) {
    if (i >= p) volAvgPrev[i] = bad === 0 ? sum / p : NaN;
    const add = v[i];
    if (Number.isFinite(add)) sum += add; else bad++;
    if (i >= p) {
      const rem = v[i - p];
      if (Number.isFinite(rem)) sum -= rem; else bad--;
    }
  }
  return { o, h, l, c, v, volAvgPrev };
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * endIdx 時点で売り抜けの確認サインに該当すれば結果オブジェクト、しなければ null。
 * 結果の highIdx は系列内の位置（呼び出し側で日付へ変換する）。
 */
export function detectDistribution(series, endIdx, params = DISTRIBUTION_PARAMS) {
  const { o, h, l, c, v, volAvgPrev } = series;
  const e = endIdx;
  const winStart = e - requiredBars(params);
  if (winStart < 0) return null;

  // 1. 窓の品質：欠損・分割疑いの除外
  for (let i = winStart; i <= e; i++) {
    if (![o[i], h[i], l[i], c[i], v[i]].every(Number.isFinite) || c[i] <= 0 || o[i] <= 0) return null;
    if (i > winStart && Math.abs(c[i] / c[i - 1] - 1) > params.splitGuardAbsChange) return null;
  }

  // 2. 大陰線（陰線・実体下落率・実体の値幅比）
  if (!(c[e] < o[e])) return null;
  const range = h[e] - l[e];
  if (!(range > 0)) return null;
  const bodyPct = (o[e] - c[e]) / o[e];
  if (bodyPct < params.minBodyPct) return null;
  if ((o[e] - c[e]) / range < params.minBodyRatio) return null;

  // 3. 出来高（直前平均比）
  const avg = volAvgPrev[e];
  if (!(avg > 0)) return null;
  const volRatio = v[e] / avg;
  if (volRatio < params.minVolumeMult) return null;

  // 4. 高値圏：判定日を含まない直近 trendLookbackBars 本の高値（同値は後の日を優先）
  let iH = e - params.trendLookbackBars;
  for (let i = iH + 1; i <= e - 1; i++) if (h[i] >= h[iH]) iH = i;
  const highPrice = h[iH];
  const highGap = c[e - 1] / highPrice - 1; // 0 以下。0 に近いほど高値圏
  if (highGap < -params.nearHighTol) return null;

  // 5. 直前の上昇：高値の日までの安値の最小から高値までの上昇率
  let lowMin = Infinity;
  for (let i = e - params.trendLookbackBars; i <= iH; i++) if (l[i] < lowMin) lowMin = l[i];
  const rise = highPrice / lowMin - 1;
  if (rise < params.minRise) return null;

  return {
    open: round(o[e], 2),
    close: round(c[e], 2),
    bodyPct: round(bodyPct * 100, 4),            // 画面条件の指標値（％）
    dropPct: round((c[e] / c[e - 1] - 1) * 100, 2), // 前日比（％。表示用）
    volRatio: round(volRatio, 4),                // 画面条件の指標値（倍）
    turnover: Math.round(c[e] * v[e]),           // 推定売買代金（円。表示用）
    highPrice: round(highPrice, 2),
    highGapPct: round(highGap * 100, 4),         // 画面条件の指標値（％。0 以下）
    risePct: round(rise * 100, 4),               // 画面条件の指標値（％）
    highIdx: iH,
  };
}
