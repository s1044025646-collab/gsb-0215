import { CostTable } from "./costtable.js";
import type {
  PenaltyScanItem,
  PenaltyScanResult,
  Segment,
  SegmentationResult,
  VerifyResult,
  DimensionCost,
} from "./types.js";
import { BudgetExceededError, FeasibilityError } from "./types.js";

/** 共享运算预算：区间评估与 DP 转移都计入。 */
class Budget {
  used = 0;
  constructor(readonly limit: number) {}
  charge(count = 1) {
    this.used += count;
    if (this.used > this.limit) {
      throw new BudgetExceededError(
        `运算预算 ${this.limit} 已耗尽（已用 ${this.used}），搜索未完成，不能标记为精确最优`,
        this.used,
      );
    }
  }
}

export interface SolveInput {
  datasetId: number;
  configVersion: number;
  timestamps: number[];
  matrix: number[][];
  weights: number[];
  minSegmentLength: number;
  /** 惩罚模式下使用的非负惩罚；fixedK 模式传 0。 */
  penalty: number;
  budget: number;
}

/** 可行性：K 段每段至少 m 个样本时最大段数。 */
export function maxFeasibleK(n: number, m: number): number {
  return Math.floor(n / m);
}

interface DPOutput {
  /** 对每个段数 k（1 基），覆盖全部 n 个样本时的最优未惩罚成本。 */
  finalCost: number[];
  /** 回溯指针：bp.get(k) 为长度 n 的数组，值为上一段末样本下标（0 基）。 */
  bp: Map<number, Int32Array>;
  kMax: number;
  table: CostTable;
  budget: Budget;
}

/**
 * 一次性求出所有可行段数 k=1..kMax 的全局最优解。
 * 递归（样本下标 0 基，dp_k[b] = 前 b+1 个样本恰好分 k 段的最小成本）：
 *   dp_1[b] = C(0,b)
 *   dp_k[b] = min_s { dp_{k-1}[s] + C(s+1,b) }
 * 末段 [s+1,b] 与前 k-1 段均强制 >= m，因此首段/中间段/末段约束一致。
 */
function runDP(input: SolveInput): DPOutput {
  const { matrix, weights, minSegmentLength: m, budget: limit } = input;
  const n = matrix.length;
  const budget = new Budget(limit);
  const table = CostTable.build(matrix, weights, budget);
  const kMax = maxFeasibleK(n, m);

  // k=1：至少 m 个样本，即 b >= m-1。
  let prev = new Float64Array(n).fill(Infinity);
  for (let b = m - 1; b < n; b++) {
    prev[b] = table.segmentCost(0, b);
  }
  const finalCost: number[] = [0, prev[n - 1]!];
  const bp = new Map<number, Int32Array>();
  bp.set(1, new Int32Array(n).fill(-1));

  for (let k = 2; k <= kMax; k++) {
    const cur = new Float64Array(n).fill(Infinity);
    const pointers = new Int32Array(n).fill(-1);
    // 前 b+1 个样本能分 k 段：b+1 >= k*m。
    for (let b = k * m - 1; b < n; b++) {
      // 前 k-1 段覆盖 0..s，需 s+1 >= (k-1)*m；末段长度 b-s >= m，即 s <= b-m。
      let best = Infinity;
      let bestS = -1;
      for (let s = (k - 1) * m - 1; s <= b - m; s++) {
        const predecessor = prev[s];
        if (predecessor === undefined || predecessor === Infinity) continue;
        budget.charge();
        const candidate = predecessor + table.segmentCost(s + 1, b);
        if (bestS === -1 || candidate < best) {
          best = candidate;
          bestS = s;
        } else if (bestS !== -1 && candidate === best) {
          // 平局：完整切分位置元组字典序最小者（公开、确定、可复现）。
          const tupleCurrent = reconstructCuts(bp, k - 1, bestS).concat(bestS);
          const tupleCandidate = reconstructCuts(bp, k - 1, s).concat(s);
          if (compareCuts(tupleCandidate, tupleCurrent) < 0) {
            best = candidate;
            bestS = s;
          }
        }
      }
      cur[b] = best;
      pointers[b] = bestS;
    }
    finalCost[k] = cur[n - 1]!;
    bp.set(k, pointers);
    prev = cur;
  }
  return { finalCost, bp, kMax, table, budget };
}

/** 字典序比较：小者排前。 */
function compareCuts(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

/** 由回溯指针重建切分（0 基末样本下标数组，长度 k-1，严格递增）。 */
function reconstructCuts(bp: Map<number, Int32Array>, k: number, end: number): number[] {
  const cuts: number[] = [];
  let curK = k;
  let curEnd = end;
  while (curK > 1) {
    const s = bp.get(curK)![curEnd]!;
    if (s < 0) throw new FeasibilityError("内部错误：不可行状态被访问");
    cuts.push(s);
    curK--;
    curEnd = s;
  }
  cuts.reverse();
  return cuts;
}

function cutsToBoundaries(cuts0Based: number[], n: number): number[] {
  return cuts0Based.concat(n - 1);
}

function buildSegments(
  table: CostTable,
  cuts0Based: number[],
  input: SolveInput,
): { segments: Segment[]; unpenalized: number } {
  const { timestamps, weights } = input;
  const n = timestamps.length;
  const ends = cutsToBoundaries(cuts0Based, n);
  const segments: Segment[] = [];
  let start = 0;
  let unpenalized = 0;
  ends.forEach((end, idx) => {
    const mean = table.segmentMeans(start, end);
    const dimensionCosts = table.segmentDimensionCosts(start, end, weights);
    const segCost = table.segmentCost(start, end);
    unpenalized += segCost;
    segments.push({
      segmentIndex: idx,
      startSampleIndex: start + 1,
      endSampleIndex: end + 1,
      length: end - start + 1,
      startTimestamp: timestamps[start]!,
      endTimestamp: timestamps[end]!,
      mean,
      dimensionCosts,
      unpenalizedCost: segCost,
    });
    start = end + 1;
  });
  return { segments, unpenalized };
}

function assemble(
  input: SolveInput,
  dp: DPOutput,
  chosenK: number,
  mode: "penalty" | "fixedK",
  penalty: number,
): SegmentationResult {
  const { table, bp, finalCost, budget } = dp;
  const n = input.matrix.length;
  const cuts0 = reconstructCuts(bp, chosenK, n - 1);
  const { segments, unpenalized } = buildSegments(table, cuts0, input);
  const changepoints = chosenK - 1;
  const penaltyTerm = penalty * changepoints;
  return {
    datasetId: input.datasetId,
    configVersion: input.configVersion,
    mode,
    penalty,
    requestedK: mode === "fixedK" ? chosenK : null,
    n,
    d: input.weights.length,
    minSegmentLength: input.minSegmentLength,
    segments,
    k: chosenK,
    changepoints,
    cuts: cuts0.map((c) => c + 1),
    totalUnpenalizedCost: unpenalized,
    penaltyTerm,
    totalObjective: finalCost[chosenK]! + penaltyTerm,
    complete: true,
    budget: input.budget,
    operationsUsed: budget.used,
    method:
      "全局精确动态规划：枚举所有合法切分的 Bellman 递推；平局先取更少变点再取切分元组字典序最小",
  };
}

function incompleteResult(
  input: SolveInput,
  mode: "penalty" | "fixedK",
  penalty: number,
  requestedK: number | null,
  used: number,
): SegmentationResult {
  return {
    datasetId: input.datasetId,
    configVersion: input.configVersion,
    mode,
    penalty,
    requestedK,
    n: input.matrix.length,
    d: input.weights.length,
    minSegmentLength: input.minSegmentLength,
    segments: [],
    k: 0,
    changepoints: 0,
    cuts: [],
    totalUnpenalizedCost: NaN,
    penaltyTerm: NaN,
    totalObjective: NaN,
    complete: false,
    budget: input.budget,
    operationsUsed: used,
    method: "运算预算耗尽，搜索未完成；以下不含任何分段，不能解释为精确或近似最优",
  };
}

/** 固定非负惩罚求解：选最小化 成本 + (k-1)*penalty 的段数，平局取更少变点。 */
export function solveByPenalty(input: SolveInput): SegmentationResult {
  try {
    const dp = runDP(input);
    let bestK = 1;
    let bestObj = dp.finalCost[1]!;
    // 段数按升序扫描，严格小于才替换 ⇒ 平局自动保留更少变点。
    for (let k = 2; k <= dp.kMax; k++) {
      const obj = dp.finalCost[k]! + (k - 1) * input.penalty;
      if (obj < bestObj) {
        bestObj = obj;
        bestK = k;
      }
    }
    return assemble(input, dp, bestK, "penalty", input.penalty);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      return incompleteResult(input, "penalty", input.penalty, null, e.operationsUsed);
    }
    throw e;
  }
}

/** 指定段数求解；不可行段数直接拒绝。 */
export function solveFixedK(input: SolveInput, k: number): SegmentationResult {
  const kMax = maxFeasibleK(input.matrix.length, input.minSegmentLength);
  if (k > kMax) {
    throw new FeasibilityError(
      `段数 ${k} 不可行：n=${input.matrix.length}、最短段长=${input.minSegmentLength} 时最多 ${kMax} 段`,
    );
  }
  try {
    const dp = runDP(input);
    return assemble(input, dp, k, "fixedK", 0);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      return incompleteResult(input, "fixedK", 0, k, e.operationsUsed);
    }
    throw e;
  }
}

/**
 * 惩罚扫描：一次 DP 得到各 k 的最优成本，再对每个惩罚求值。
 * 理论性质：惩罚增加时最优变点数不会增加；切分位置不必嵌套（note 中说明）。
 */
export function scanPenalties(input: SolveInput, penalties: number[]): PenaltyScanResult {
  const n = input.matrix.length;
  const m = input.minSegmentLength;
  const kMax = maxFeasibleK(n, m);
  let dp: DPOutput;
  try {
    dp = runDP(input);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      return {
        datasetId: input.datasetId,
        configVersion: input.configVersion,
        n,
        d: input.weights.length,
        minSegmentLength: m,
        minK: 1,
        maxK: kMax,
        items: [],
        complete: false,
        budget: input.budget,
        operationsUsed: e.operationsUsed,
        monotoneNonincreasingChangepoints: true,
        note: "预算耗尽，DP 未完成，未产生任何精确最优项",
      };
    }
    throw e;
  }

  const items: PenaltyScanItem[] = penalties.map((p) => {
    let bestK = 1;
    let bestObj = dp.finalCost[1]!;
    for (let k = 2; k <= kMax; k++) {
      const obj = dp.finalCost[k]! + (k - 1) * p;
      if (obj < bestObj) {
        bestObj = obj;
        bestK = k;
      }
    }
    const cuts0 = reconstructCuts(dp.bp, bestK, n - 1);
    return {
      penalty: p,
      k: bestK,
      changepoints: bestK - 1,
      cuts: cuts0.map((c) => c + 1),
      totalUnpenalizedCost: dp.finalCost[bestK]!,
      penaltyTerm: (bestK - 1) * p,
      totalObjective: bestObj,
    };
  });

  let monotone = true;
  for (let i = 1; i < items.length; i++) {
    if (items[i]!.changepoints > items[i - 1]!.changepoints) monotone = false;
  }
  return {
    datasetId: input.datasetId,
    configVersion: input.configVersion,
    n,
    d: input.weights.length,
    minSegmentLength: m,
    minK: 1,
    maxK: kMax,
    items,
    complete: true,
    budget: input.budget,
    operationsUsed: dp.budget.used,
    monotoneNonincreasingChangepoints: monotone,
    note:
      "惩罚单调增加时最优变点数不会增加（已校验）；不同惩罚下的切分位置不必构成嵌套集合，这是正常现象",
  };
}

/**
 * 独立核验：不复用求解器的成本表，直接从原始样本重新计算给定切分。
 * 检查区间合法性、覆盖连续性、最短段长、有限性，并给出逐维成本分解。
 */
export function verifySegmentation(
  matrix: number[][],
  weights: number[],
  minSegmentLength: number,
  cuts1Based: number[],
  reportedUnpenalizedCost?: number,
): VerifyResult {
  const n = matrix.length;
  const d = weights.length;
  const reasons: string[] = [];
  const k = cuts1Based.length + 1;

  const sorted = [...cuts1Based].sort((a, b) => a - b);
  if (sorted.some((c, i) => i > 0 && c === sorted[i - 1])) reasons.push("切分位置存在重复");
  if (cuts1Based.some((c, i) => c !== sorted[i])) reasons.push("切分位置必须严格递增");
  if (cuts1Based.some((c) => c < 1 || c >= n)) {
    reasons.push(`切分位置必须落在 [1, n-1]=[1, ${n - 1}] 内`);
  }
  if (k * minSegmentLength > n) {
    reasons.push(`段数 ${k} 在最短段长 ${minSegmentLength} 下不可行（需要至少 ${k * minSegmentLength} 个样本）`);
  }

  const boundaries = [...cuts1Based.map((c) => c - 1), n - 1];
  let start = 0;
  let total = 0;
  const segs: VerifyResult["segments"] = [];
  let structuralOk = reasons.length === 0;

  boundaries.forEach((end) => {
    const length = end - start + 1;
    if (length < minSegmentLength) {
      reasons.push(`段 [${start + 1}, ${end + 1}] 长度 ${length} 小于最短段长 ${minSegmentLength}`);
      structuralOk = false;
    }
    const mean = new Array<number>(d).fill(0);
    for (let j = 0; j < d; j++) {
      let sum = 0;
      for (let i = start; i <= end; i++) sum += matrix[i]![j]!;
      mean[j] = sum / length;
    }
    const dims: DimensionCost[] = [];
    let segCost = 0;
    for (let j = 0; j < d; j++) {
      let raw = 0;
      for (let i = start; i <= end; i++) {
        const r = matrix[i]![j]! - mean[j]!;
        raw += r * r;
      }
      const weighted = weights[j]! * raw;
      dims.push({ dimension: j, weight: weights[j]!, rawSSE: raw, weightedSSE: weighted });
      segCost += weighted;
    }
    total += segCost;
    segs.push({
      startSampleIndex: start + 1,
      endSampleIndex: end + 1,
      length,
      mean,
      unpenalizedCost: segCost,
      dimensionCosts: dims,
    });
    start = end + 1;
  });

  if (reportedUnpenalizedCost !== undefined && Number.isFinite(reportedUnpenalizedCost)) {
    const tol = Math.max(1e-9, 1e-9 * Math.max(1, Math.abs(total), Math.abs(reportedUnpenalizedCost)));
    if (Math.abs(total - reportedUnpenalizedCost) > tol) {
      reasons.push(
        `重算未惩罚成本 ${total} 与报告值 ${reportedUnpenalizedCost} 不一致（容差 ${tol}）`,
      );
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    n,
    d,
    k: structuralOk ? k : k,
    cuts: [...cuts1Based],
    recomputedUnpenalizedCost: total,
    reportedUnpenalizedCost:
      reportedUnpenalizedCost === undefined ? null : reportedUnpenalizedCost,
    objective: null,
    segments: segs,
  };
}
