/**
 * 数值稳定的段成本计算。
 *
 * 关键：对每个维度，以段内第一个样本为平移基准（shift = x[start]），
 * 累加 (x - shift) 与 (x - shift)^2，再用 sumsq - sum^2/len 得到离差平方和。
 * 对“大基数 + 小波动”的序列（如 1e12 附近微小变化），平移后参与运算的
 * 都是波动量本身，避免了大数相减造成的灾难性抵消，因此不需要也不允许
 * 把负残差静默裁剪为零来掩盖精度问题。仅在浮点舍入产生微小负值
 * （相对量级 < 1e-9）时裁剪为 0，其余负值视为数值错误抛出。
 */
export function segmentResidualByDim(
  values: number[][],
  start: number,
  end: number,
): number[] {
  const dim = values[0].length;
  const len = end - start;
  const out = new Array<number>(dim).fill(0);
  for (let d = 0; d < dim; d++) {
    const shift = values[start][d];
    let sum = 0;
    let sumsq = 0;
    for (let i = start; i < end; i++) {
      const z = values[i][d] - shift;
      sum += z;
      sumsq += z * z;
    }
    let rss = sumsq - (sum * sum) / len;
    if (rss < 0) {
      const scale = sumsq > 0 ? sumsq : 1;
      if (-rss <= 1e-9 * scale) {
        rss = 0;
      } else {
        throw new Error(`数值错误：段 [${start},${end}) 维度 ${d} 残差为负 (${rss})`);
      }
    }
    out[d] = rss;
  }
  return out;
}

/** 段内均值向量（平移法计算，稳定）。 */
export function segmentMean(
  values: number[][],
  start: number,
  end: number,
): number[] {
  const dim = values[0].length;
  const len = end - start;
  const out = new Array<number>(dim).fill(0);
  for (let d = 0; d < dim; d++) {
    const shift = values[start][d];
    let sum = 0;
    for (let i = start; i < end; i++) sum += values[i][d] - shift;
    out[d] = shift + sum / len;
  }
  return out;
}

/** 段成本 = 各维离差平方和的加权和。 */
export function segmentCost(
  values: number[][],
  start: number,
  end: number,
  weights: number[],
): number {
  const rss = segmentResidualByDim(values, start, end);
  let total = 0;
  for (let d = 0; d < rss.length; d++) total += weights[d] * rss[d];
  return total;
}

/**
 * 预计算段成本矩阵（仅长度 >= minLen 的区间）。
 * cellCost[start][endExclusive] 对非法区间为 null。
 * 每个起点一次平移扫描，整体 O(n^2 * dim)。
 */
export function buildCostMatrix(
  values: number[][],
  weights: number[],
  minLen: number,
  budget: { maxCostCells: number },
  counter: { cells: number },
): (number | null)[][] {
  const n = values.length;
  const dim = values[0].length;
  const matrix: (number | null)[][] = Array.from({ length: n }, () =>
    new Array<number | null>(n + 1).fill(null),
  );
  for (let s = 0; s < n; s++) {
    const sum = new Array<number>(dim).fill(0);
    const sumsq = new Array<number>(dim).fill(0);
    const shift = values[s];
    for (let e = s + 1; e <= n; e++) {
      const row = values[e - 1];
      for (let d = 0; d < dim; d++) {
        const z = row[d] - shift[d];
        sum[d] += z;
        sumsq[d] += z * z;
      }
      const len = e - s;
      if (len < minLen) continue;
      counter.cells++;
      if (counter.cells > budget.maxCostCells) {
        throw new BudgetExceeded(
          `段成本单元数超过预算 ${budget.maxCostCells}`,
        );
      }
      let total = 0;
      for (let d = 0; d < dim; d++) {
        let rss = sumsq[d] - (sum[d] * sum[d]) / len;
        if (rss < 0) {
          const scale = sumsq[d] > 0 ? sumsq[d] : 1;
          if (-rss <= 1e-9 * scale) rss = 0;
          else
            throw new Error(
              `数值错误：段 [${s},${e}) 维度 ${d} 残差为负 (${rss})`,
            );
        }
        total += weights[d] * rss;
      }
      matrix[s][e] = total;
    }
  }
  return matrix;
}

export class BudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceeded';
  }
}
