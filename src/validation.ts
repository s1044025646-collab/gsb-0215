import { ValidationError } from "./types.js";

/** 严格校验输入行：全部维度有限、时间戳有限、无缺失维度、时间严格递增、无重复时间。 */
export function validateRows(
  rows: Array<{ timestamp: unknown; values: unknown }>,
): { timestamps: number[]; matrix: number[][] } {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ValidationError("样本序列不能为空");
  }
  const d = inferDimension(rows);
  if (d <= 0) {
    throw new ValidationError("维度数必须 >=1");
  }
  const timestamps: number[] = [];
  const matrix: number[][] = [];
  let prevTs = -Infinity;
  rows.forEach((row, i) => {
    const ts = row.timestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts)) {
      throw new ValidationError(`第 ${i + 1} 条样本时间戳缺失或不是有限数`);
    }
    if (i > 0 && ts <= prevTs) {
      throw new ValidationError(
        `时间戳必须严格递增且不可重复：第 ${i + 1} 条 (${ts}) 不晚于前一条 (${prevTs})`,
      );
    }
    prevTs = ts;
    const vals = row.values;
    if (!Array.isArray(vals)) {
      throw new ValidationError(`第 ${i + 1} 条样本的 values 必须是数组`);
    }
    if (vals.length !== d) {
      throw new ValidationError(
        `第 ${i + 1} 条样本维度数为 ${vals.length}，与首条的 ${d} 不一致（不允许缺失维度）`,
      );
    }
    const cleaned: number[] = [];
    for (let j = 0; j < d; j++) {
      const v = vals[j];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new ValidationError(
          `第 ${i + 1} 条样本第 ${j + 1} 维不是有限数值（NaN/Infinity/-Infinity 均不允许）`,
        );
      }
      cleaned.push(v);
    }
    timestamps.push(ts);
    matrix.push(cleaned);
  });
  return { timestamps, matrix };
}

function inferDimension(rows: Array<{ values: unknown }>): number {
  const first = rows[0]?.values;
  return Array.isArray(first) ? first.length : 0;
}

/** 校验权重：长度等于维度数，全部为有限非负数（0 合法，表示忽略该维）。 */
export function validateWeights(weights: unknown, d: number): number[] {
  if (!Array.isArray(weights)) {
    throw new ValidationError("weights 必须是数组");
  }
  if (weights.length !== d) {
    throw new ValidationError(`weights 长度 ${weights.length} 与维度数 ${d} 不一致`);
  }
  return weights.map((w, j) => {
    if (typeof w !== "number" || !Number.isFinite(w)) {
      throw new ValidationError(`第 ${j + 1} 维权重不是有限数（负权重/NaN/Infinity 均不允许）`);
    }
    if (w < 0) {
      throw new ValidationError(`第 ${j + 1} 维权重为负数 ${w}，特征权重必须非负`);
    }
    return w;
  });
}

export function validateMinSegmentLength(m: unknown, n: number): number {
  if (typeof m !== "number" || !Number.isInteger(m) || m < 1) {
    throw new ValidationError("minSegmentLength 必须是 >=1 的整数（按样本数计）");
  }
  if (m > n) {
    throw new ValidationError(`minSegmentLength=${m} 大于样本总数 ${n}，连一段都放不下`);
  }
  return m;
}

export function validatePenalty(p: unknown): number {
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0) {
    throw new ValidationError("penalty 必须是非负有限数");
  }
  return p;
}

export function validateK(k: unknown): number {
  if (typeof k !== "number" || !Number.isInteger(k) || k < 1) {
    throw new ValidationError("段数 k 必须是 >=1 的整数");
  }
  return k;
}

/** 预算：允许的段成本评估次数；必须为正整数。 */
export function validateBudget(b: unknown): number {
  if (b === undefined || b === null) return Number.MAX_SAFE_INTEGER;
  if (typeof b !== "number" || !Number.isInteger(b) || b < 1) {
    throw new ValidationError("budget 必须是 >=1 的整数（段成本评估次数）");
  }
  return b;
}
