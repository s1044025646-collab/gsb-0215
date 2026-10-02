import { segmentMean, segmentResidualByDim } from './cost.js';
import type { FitOk, Sample } from './types.js';

/**
 * 独立核验：从原始样本出发，对外部给定的分段（变点列表）重算
 * 均值向量、每维残差、未惩罚成本、惩罚项与总目标。
 * 不依赖拟合路径，可用于复核任何来源的分段。
 */
export function verifySegmentation(
  samples: Sample[],
  weights: number[],
  minLen: number,
  changepoints: number[],
  penalty: number | null,
): FitOk {
  const n = samples.length;
  const cps = [...changepoints].sort((a, b) => a - b);
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (!Number.isInteger(cp) || cp <= 0 || cp >= n) {
      throw new Error(`非法变点 ${cp}：必须是 (0, ${n}) 内的整数样本下标`);
    }
    if (i > 0 && cp === cps[i - 1]) {
      throw new Error(`重复变点 ${cp}`);
    }
  }
  const bounds = [0, ...cps, n];
  const values = samples.map((s) => s.values);
  const segments = [];
  let unpenalized = 0;
  for (let s = 0; s + 1 < bounds.length; s++) {
    const start = bounds[s];
    const end = bounds[s + 1];
    if (end - start < minLen) {
      throw new Error(
        `段 [${start},${end}) 长度 ${end - start} 违反最短段长 ${minLen}`,
      );
    }
    const rss = segmentResidualByDim(values, start, end);
    const mean = segmentMean(values, start, end);
    let segCost = 0;
    for (let d = 0; d < rss.length; d++) segCost += weights[d] * rss[d];
    unpenalized += segCost;
    segments.push({ start, end, mean, residualByDim: rss, cost: segCost });
  }
  const penaltyTerm = penalty === null ? 0 : penalty * cps.length;
  return {
    status: 'ok',
    changepoints: cps,
    segments,
    unpenalizedCost: unpenalized,
    penaltyTerm,
    objective: unpenalized + penaltyTerm,
    penalty,
    segmentCount: segments.length,
  };
}
