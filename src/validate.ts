import type { DatasetConfig, Sample } from './types.js';

/**
 * 导入校验：
 * - 时间戳必须为有限数且严格递增（重复时间拒绝）；
 * - 每条样本的维度必须与声明维度一致（缺失维度拒绝）；
 * - 所有数值必须有限（NaN/Infinity 拒绝）；
 * - 特征权重必须为非负有限数（负权重拒绝）；
 * - 最短段长为 >=1 的整数。
 */
export function validateImport(
  samples: Sample[],
  config: DatasetConfig,
): { dim: number } {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('样本列表不能为空');
  }
  const { weights, minSegmentLength } = config;
  if (!Number.isInteger(minSegmentLength) || minSegmentLength < 1) {
    throw new Error('最短段长必须是 >=1 的整数（单位：样本数）');
  }
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new Error('特征权重不能为空');
  }
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) {
      throw new Error(`特征权重必须是非负有限数，收到 ${w}`);
    }
  }
  const dim = weights.length;
  let prevT: number | null = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!Number.isFinite(s.t)) {
      throw new Error(`样本 ${i} 的时间戳非有限值`);
    }
    if (prevT !== null && s.t <= prevT) {
      throw new Error(`样本 ${i} 的时间戳 ${s.t} 未严格递增（重复或倒序）`);
    }
    prevT = s.t;
    if (!Array.isArray(s.values) || s.values.length !== dim) {
      throw new Error(
        `样本 ${i} 维度 ${s.values?.length} 与权重维度 ${dim} 不一致（缺失维度）`,
      );
    }
    for (const v of s.values) {
      if (!Number.isFinite(v)) {
        throw new Error(`样本 ${i} 含非有限值 ${v}`);
      }
    }
  }
  return { dim };
}
