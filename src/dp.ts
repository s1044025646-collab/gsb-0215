import { BudgetExceeded, buildCostMatrix } from './cost.js';
import type { Budget, FitResult, Sample } from './types.js';

/**
 * 平局判定（公开规则，确定性）：
 * 1. 总目标更小者胜（浮点严格比较）；
 * 2. 目标相同，变点数更少者胜；
 * 3. 仍相同，按变点位置列表的字典序，靠前者胜（切分位置越小越靠前越优先）。
 */
interface Candidate {
  objective: number;
  changepoints: number[]; // 升序，新段起始下标
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.objective !== b.objective) return a.objective < b.objective ? -1 : 1;
  if (a.changepoints.length !== b.changepoints.length) {
    return a.changepoints.length - b.changepoints.length;
  }
  for (let i = 0; i < a.changepoints.length; i++) {
    if (a.changepoints[i] !== b.changepoints[i]) {
      return a.changepoints[i] - b.changepoints[i];
    }
  }
  return 0;
}

function better(a: Candidate, b: Candidate | null): Candidate {
  if (b === null) return a;
  return compareCandidates(a, b) <= 0 ? a : b;
}

interface DpContext {
  values: number[][];
  weights: number[];
  minLen: number;
  budget: Budget;
}

function prepare(samples: Sample[], weights: number[], minLen: number, budget: Budget) {
  const values = samples.map((s) => s.values);
  const counter = { cells: 0 };
  const cost = buildCostMatrix(values, weights, minLen, budget, counter);
  const ctx: DpContext = { values, weights, minLen, budget };
  return { values, cost, counter, ctx };
}

/**
 * 固定非负惩罚的全局最优分段（精确 DP，非贪心）。
 * 目标 = 各段加权残差平方和 + penalty * 变点数，变点数 = 段数 - 1。
 */
export function fitWithPenalty(
  samples: Sample[],
  weights: number[],
  minLen: number,
  penalty: number,
  budget: Budget,
): FitResult {
  if (!Number.isFinite(penalty) || penalty < 0) {
    throw new Error('惩罚必须是非负有限数');
  }
  const n = samples.length;
  if (n < minLen) {
    throw new Error(`样本数 ${n} 小于最短段长 ${minLen}，无法构成任何合法分段`);
  }
  try {
    const { cost } = prepare(samples, weights, minLen, budget);
    let transitions = 0;
    // F[i]：前 i 个样本（下标 [0,i)）的最优解，目标含惩罚。
    const F: (Candidate | null)[] = new Array(n + 1).fill(null);
    F[0] = { objective: -penalty, changepoints: [] }; // 抵消最后一段多算的一次惩罚
    for (let i = minLen; i <= n; i++) {
      let bestC: Candidate | null = null;
      for (let j = 0; j <= i - minLen; j++) {
        const prev = F[j];
        if (prev === null) continue;
        const cell = cost[j][i];
        if (cell === null) continue;
        transitions++;
        if (transitions > budget.maxDpTransitions) {
          throw new BudgetExceeded(`DP 转移次数超过预算 ${budget.maxDpTransitions}`);
        }
        bestC = better(
          {
            objective: prev.objective + cell + penalty,
            changepoints: j === 0 ? [] : [...prev.changepoints, j],
          },
          bestC,
        );
      }
      F[i] = bestC;
    }
    const final = F[n];
    if (final === null) throw new Error('无可行分段');
    return buildResult(samples, weights, minLen, final.changepoints, penalty);
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      return { status: 'incomplete', reason: err.message };
    }
    throw err;
  }
}

/**
 * 指定段数 K 的全局最优分段（精确 DP）。
 * 首段、末段与所有中间段均满足最短段长；K 不可行时拒绝。
 */
export function fitWithSegments(
  samples: Sample[],
  weights: number[],
  minLen: number,
  segments: number,
  budget: Budget,
): FitResult {
  const n = samples.length;
  if (!Number.isInteger(segments) || segments < 1) {
    throw new Error('段数必须是正整数');
  }
  if (segments * minLen > n) {
    throw new Error(
      `不可行：${segments} 段 × 最短段长 ${minLen} > 样本数 ${n}`,
    );
  }
  try {
    const { cost } = prepare(samples, weights, minLen, budget);
    let transitions = 0;
    // dp[i]：当前段数下，前 i 个样本的最优（成本不含惩罚）。
    let dp: (Candidate | null)[] = new Array(n + 1).fill(null);
    dp[0] = { objective: 0, changepoints: [] };
    for (let k = 1; k <= segments; k++) {
      const next: (Candidate | null)[] = new Array(n + 1).fill(null);
      // 末段约束：第 k 段结束后，剩余样本须够剩下 segments-k 段。
      const minI = k * minLen;
      const maxI = n - (segments - k) * minLen;
      for (let i = minI; i <= maxI; i++) {
        let bestC: Candidate | null = null;
        for (let j = (k - 1) * minLen; j <= i - minLen; j++) {
          const prev = dp[j];
          if (prev === null) continue;
          const cell = cost[j][i];
          if (cell === null) continue;
          transitions++;
          if (transitions > budget.maxDpTransitions) {
            throw new BudgetExceeded(`DP 转移次数超过预算 ${budget.maxDpTransitions}`);
          }
          bestC = better(
            {
              objective: prev.objective + cell,
              changepoints: j === 0 ? [] : [...prev.changepoints, j],
            },
            bestC,
          );
        }
        next[i] = bestC;
      }
      dp = next;
    }
    const final = dp[n];
    if (final === null) throw new Error('无可行分段');
    return buildResult(samples, weights, minLen, final.changepoints, null);
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      return { status: 'incomplete', reason: err.message };
    }
    throw err;
  }
}

/** 由变点列表构造完整结果（均值、每维残差、成本分解）。 */
export function buildResult(
  samples: Sample[],
  weights: number[],
  minLen: number,
  changepoints: number[],
  penalty: number | null,
): FitResult {
  const n = samples.length;
  const bounds = [0, ...changepoints, n];
  const segments = [];
  let unpenalized = 0;
  for (let s = 0; s + 1 < bounds.length; s++) {
    const start = bounds[s];
    const end = bounds[s + 1];
    if (end - start < minLen) {
      throw new Error(`段 [${start},${end}) 长度 ${end - start} 小于最短段长 ${minLen}`);
    }
    const rss = residualByDim(samples, start, end);
    const mean = meanOf(samples, start, end);
    let segCost = 0;
    for (let d = 0; d < rss.length; d++) segCost += weights[d] * rss[d];
    unpenalized += segCost;
    segments.push({ start, end, mean, residualByDim: rss, cost: segCost });
  }
  const cpCount = changepoints.length;
  const penaltyTerm = penalty === null ? 0 : penalty * cpCount;
  return {
    status: 'ok',
    changepoints: [...changepoints],
    segments,
    unpenalizedCost: unpenalized,
    penaltyTerm,
    objective: unpenalized + penaltyTerm,
    penalty,
    segmentCount: segments.length,
  };
}

function residualByDim(samples: Sample[], start: number, end: number): number[] {
  const values = samples.map((s) => s.values);
  // 延迟加载避免循环依赖：直接使用 cost 模块的函数。
  return segmentResidualByDimLocal(values, start, end);
}

function meanOf(samples: Sample[], start: number, end: number): number[] {
  const dim = samples[0].values.length;
  const len = end - start;
  const out = new Array<number>(dim).fill(0);
  for (let d = 0; d < dim; d++) {
    const shift = samples[start].values[d];
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i].values[d] - shift;
    out[d] = shift + sum / len;
  }
  return out;
}

import { segmentResidualByDim as segmentResidualByDimLocal } from './cost.js';
