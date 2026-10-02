import type { DimensionCost } from "./types.js";
import { BudgetExceededError } from "./types.js";

/**
 * 区间成本表，仅按样本下标计算，与时间间隔无关。
 *
 * 数值稳定性：对每个起点 a 用 Welford 在线算法向前推进到每个终点 b。
 * 均值与二阶中心矩 M2 以递推方式更新，即使序列形如 1e12 + 微小波动，
 * 也不会用 Σx²−(Σx)²/n 这类大数相减公式；M2 由带 (mean−x) 因子的
 * 增量累加得到，天然非负，不做任何“负残差裁零”。
 */
export class CostTable {
  readonly n: number;
  readonly d: number;
  /** rows[a] 对应起点 a（0 基）；每个有效终点存均值、SSE 与加权成本。 */
  private readonly rows: Array<{
    origin: Float64Array;
    mean: Float64Array;
    sse: Float64Array;
    cost: Float64Array;
  }>;
  /** 构建过程中消耗的段成本评估次数（每个 (a,b) 区间计 1 次，与 d 无关）。 */
  evaluations: number;

  private constructor(
    n: number,
    d: number,
    rows: CostTable["rows"],
    evaluations: number,
  ) {
    this.n = n;
    this.d = d;
    this.rows = rows;
    this.evaluations = evaluations;
  }

  /**
   * 构建全部区间 [a,b]（0 基，闭区间）的统计量。
   * @param budget 允许的区间评估次数上限；超出立即中断（调用方只能得到未完成）。
   */
  static build(
    matrix: number[][],
    weights: number[],
    budget:
      | number
      | { limit: number; used: number; charge: (n?: number) => void },
  ): CostTable {
    const n = matrix.length;
    const d = weights.length;
    const rows: CostTable["rows"] = [];
    let used = 0;
    const charge =
      typeof budget === "number"
        ? () => {
            used++;
            if (used > budget) {
              throw new BudgetExceededError(
                `运算预算 ${budget} 次区间评估已耗尽，仅完成 ${used} 次，结果不能标记为精确最优`,
                used,
              );
            }
          }
        : () => budget.charge();
    for (let a = 0; a < n; a++) {
      const len = n - a;
      // 段原点：该段首样本。任何区间 [a,b] 的方差与首值平移严格无关，
      // 从而 1e12 基值 + 1e-6 波动也不会发生大数相减。
      const segOrigin = matrix[a]!.slice();
      const mean = new Float64Array(len * d);
      const sse = new Float64Array(len * d);
      const cost = new Float64Array(len);
      const originArr = Float64Array.from(segOrigin);
      // 每维独立的 Welford 计数 / 均值 / M2。
      const count = new Int32Array(d);
      const curMean = new Float64Array(d);
      const m2Main = new Float64Array(d);
      const m2Comp = new Float64Array(d);
      for (let b = a; b < n; b++) {
        const x = matrix[b]!;
        let weightedCost = 0;
        for (let j = 0; j < d; j++) {
          // 平移空间内的 Welford：原点为段首样本，delta 只在“小数量级”上发生。
          count[j] = count[j]! + 1;
          const cnt = count[j]!;
          const xv = x[j]! - segOrigin[j]!;
          const delta = xv - curMean[j]!;
          const newMean = curMean[j]! + delta / cnt;
          const delta2 = xv - curMean[j]!;
          const delta3 = xv - newMean;
          const term = delta2 * delta3;
          // Neumaier 补偿累加 M2：主/补分量分开保存，仅读取时相加；绝不裁负。
          const oldMain = m2Main[j]!;
          const acc = oldMain + term;
          if (Math.abs(oldMain) >= Math.abs(term)) m2Comp[j]! += oldMain - acc + term;
          else m2Comp[j]! += term - acc + oldMain;
          m2Main[j] = acc;
          curMean[j] = newMean;
          const off = (b - a) * d + j;
          mean[off] = curMean[j]!;
          const raw = m2Main[j]! + m2Comp[j]!;
          const s = raw === 0 ? 0 : raw;
          sse[off] = s;
          weightedCost += weights[j]! * s;
        }
        cost[b - a] = weightedCost;
        used++;
        charge();
      }
      rows.push({ origin: originArr, mean, sse, cost });
    }
    return new CostTable(n, d, rows, typeof budget === "number" ? used : budget.used);
  }

  /** 区间 [a,b]（0 基闭区间）的加权残差平方和。 */
  segmentCost(a: number, b: number): number {
    return this.rows[a]!.cost[b - a]!;
  }

  /** 区间各维均值（新数组）。 */
  segmentMeans(a: number, b: number): number[] {
    const row = this.rows[a]!;
    const off = (b - a) * this.d;
    return Array.from(row.mean.subarray(off, off + this.d), (v, j) => v + row.origin[j]!);
  }

  /** 区间各维原始 SSE（未乘权重）及加权分解。 */
  segmentDimensionCosts(a: number, b: number, weights: number[]): DimensionCost[] {
    const row = this.rows[a]!;
    const off = (b - a) * this.d;
    const out: DimensionCost[] = [];
    for (let j = 0; j < this.d; j++) {
      const raw = row.sse[off + j]!;
      const w = weights[j]!;
      out.push({ dimension: j, weight: w, rawSSE: raw, weightedSSE: w * raw });
    }
    return out;
  }
}
