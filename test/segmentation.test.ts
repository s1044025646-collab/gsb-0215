import { test } from "node:test";
import assert from "node:assert/strict";
import { CostTable } from "../src/costtable.js";
import {
  maxFeasibleK,
  scanPenalties,
  solveByPenalty,
  solveFixedK,
  verifySegmentation,
} from "../src/segmentation.js";
import {
  BudgetExceededError,
  FeasibilityError,
  ValidationError,
  type SolveInput,
} from "../src/types.js";
import { validateRows, validateWeights } from "../src/validation.js";

function makeInput(
  matrix: number[][],
  opts: { weights?: number[]; m?: number; penalty?: number; budget?: number } = {},
): SolveInput {
  const d = matrix[0]!.length;
  return {
    datasetId: 1,
    configVersion: 1,
    timestamps: matrix.map((_, i) => i),
    matrix,
    weights: opts.weights ?? new Array<number>(d).fill(1),
    minSegmentLength: opts.m ?? 1,
    penalty: opts.penalty ?? 0,
    budget: opts.budget ?? Number.MAX_SAFE_INTEGER,
  };
}

/** 朴素 O(n^2 * 合法切分数) 穷举：枚举所有满足最短段长的切分。 */
function bruteForce(
  matrix: number[][],
  weights: number[],
  m: number,
  penalty: number,
): { objective: number; cuts: number[]; unpenalized: number; k: number } {
  const n = matrix.length;
  const d = weights.length;
  if (n < m) throw new Error("bruteForce: n < m");
  const table = CostTable.build(
    matrix,
    weights,
    Number.MAX_SAFE_INTEGER,
  );
  let best: { objective: number; cuts: number[]; unpenalized: number; k: number } | null = null;

  // 枚举内部切分位置：选一个子集 c1<...<c_{k-1}，每段长度 >= m。
  const consider = (internal: number[]) => {
    const finalCuts = [...internal, n - 1];
    let cost = 0;
    let s = 0;
    for (const e of finalCuts) {
      cost += table.segmentCost(s, e);
      s = e + 1;
    }
    const k = finalCuts.length;
    const objective = cost + (k - 1) * penalty;
    const cuts1 = internal.map((c) => c + 1);
    if (
      best === null ||
      objective < best.objective ||
      (objective === best.objective &&
        (k < best.k || (k === best.k && JSON.stringify(cuts1) < JSON.stringify(best.cuts))))
    ) {
      best = { objective, cuts: cuts1, unpenalized: cost, k };
    }
  };

  // 用位掩码枚举相邻样本间隙 1..n-1 上的切分，小 n（<=9）足够快。
  for (let mask = 0; mask < 1 << (n - 1); mask++) {
    const internal: number[] = [];
    for (let i = 0; i < n - 1; i++) if (mask & (1 << i)) internal.push(i);
    let ok = true;
    let prevEnd = -1;
    for (const c of internal) {
      if (c - prevEnd < m) ok = false;
      prevEnd = c;
    }
    if (n - 1 - prevEnd < m) ok = false;
    if (ok) consider(internal);
  }
  return best!;
}

test("常量序列：任意惩罚下均为 1 段，成本为 0", () => {
  const matrix = Array.from({ length: 20 }, () => [7, 3]);
  const r = solveByPenalty(makeInput(matrix, { penalty: 0.1 }));
  assert.equal(r.k, 1);
  assert.equal(r.changepoints, 0);
  assert.equal(r.totalUnpenalizedCost, 0);
  assert.equal(r.totalObjective, 0);
  assert.deepEqual(r.segments[0]!.mean, [7, 3]);
});

test("单次阶跃：在阶跃边界找到 1 个变点", () => {
  const matrix = [
    ...Array.from({ length: 10 }, () => [0]),
    ...Array.from({ length: 10 }, () => [5]),
  ];
  const r = solveByPenalty(makeInput(matrix, { penalty: 1 }));
  assert.equal(r.k, 2);
  assert.deepEqual(r.cuts, [10]);
  assert.equal(r.totalUnpenalizedCost, 0);
});

test("短异常尖峰：惩罚决定是否单独成段；零惩罚倾向更多段", () => {
  const matrix = Array.from({ length: 12 }, (_, i) => [i === 0 ? 100 : 0]);
  const highPenalty = solveByPenalty(makeInput(matrix, { penalty: 100000 }));
  assert.equal(highPenalty.k, 1);
  const distinct = [5, 9, 1, 7, 3, 8, 2, 6, 0, 4, 11, 10].map((v) => [v]);
  const zero = solveByPenalty(makeInput(distinct, { penalty: 0 }));
  assert.equal(zero.k, maxFeasibleK(12, 1));
  const low = solveByPenalty(makeInput(matrix, { penalty: 10 }));
  assert.equal(low.k, 2);
  assert.deepEqual(low.cuts, [1]);
});

test("零惩罚：每点一段（受最短段长限制），残差为 0", () => {
  const matrix = [1, 5, 2, 8, 3, 9, 0, 4].map((v) => [v]);
  const r = solveByPenalty(makeInput(matrix, { penalty: 0 }));
  assert.equal(r.k, 8);
  assert.equal(r.totalUnpenalizedCost, 0);
  assert.equal(r.penaltyTerm, 0);
});

test("最短段长卡边界：首/中/末段都受限，非法切分被核验拒绝", () => {
  const matrix = [1, 1, 10, 10, 20, 20].map((v) => [v]);
  const r = solveFixedK(makeInput(matrix, { m: 2 }), 3);
  assert.equal(r.k, 3);
  for (const s of r.segments) assert.ok(s.length >= 2);
  assert.deepEqual(r.cuts, [2, 4]);
  const bad = verifySegmentation(matrix, [1], 2, [1]);
  assert.equal(bad.valid, false);
  assert.ok(bad.reasons.some((x) => x.includes("最短段长")));
});

test("不可行段数被拒绝", () => {
  const matrix = [1, 2, 3, 4].map((v) => [v]);
  assert.throws(() => solveFixedK(makeInput(matrix, { m: 2 }), 3), FeasibilityError);
});

test("穷举一致性：随机小序列上 DP 与枚举所有合法切分一致（含平局规则）", () => {
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let trial = 0; trial < 40; trial++) {
    const n = 2 + Math.floor(rand() * 8);
    const d = 1 + Math.floor(rand() * 3);
    const m = 1 + Math.floor(rand() * Math.min(2, Math.floor(n / 2)));
    const matrix = Array.from({ length: n }, () =>
      Array.from({ length: d }, () => Math.round(rand() * 10) - 5),
    );
    const weights = Array.from({ length: d }, () => (rand() < 0.3 ? 0 : 1 + rand()));
    const penalty = rand() * 8;
    const input = makeInput(matrix, { weights, m, penalty });
    const dp = solveByPenalty(input);
    const bf = bruteForce(matrix, weights, m, penalty);
    assert.ok(
      Math.abs(dp.totalObjective - bf.objective) < 1e-9,
      `trial ${trial}: objective ${dp.totalObjective} vs ${bf.objective}`,
    );
    assert.equal(dp.k, bf.k, `trial ${trial}: k mismatch`);
    assert.deepEqual(dp.cuts, bf.cuts, `trial ${trial}: cuts mismatch`);
    assert.ok(Math.abs(dp.totalUnpenalizedCost - bf.unpenalized) < 1e-9);
  }
});

test("成本分解之和等于总未惩罚成本与总目标", () => {
  const matrix = [1, 2, 10, 11, 20, 21].map((v) => [v, -v]);
  const r = solveByPenalty(makeInput(matrix, { penalty: 3, weights: [1, 2] }));
  let sum = 0;
  for (const seg of r.segments) {
    const dimSum = seg.dimensionCosts.reduce((acc, c) => acc + c.weightedSSE, 0);
    assert.ok(Math.abs(dimSum - seg.unpenalizedCost) < 1e-10);
    sum += seg.unpenalizedCost;
  }
  assert.ok(Math.abs(sum - r.totalUnpenalizedCost) < 1e-10);
  assert.ok(
    Math.abs(r.totalObjective - (r.totalUnpenalizedCost + r.penaltyTerm)) < 1e-10,
  );
});

test("平移不变性：整体加大常数不改变切分与成本", () => {
  const base = [0, 1, 0, 1, 100, 101, 100, 101].map((v) => [v]);
  const shifted = base.map(([v]) => [v + 1e9]);
  const a = solveByPenalty(makeInput(base, { penalty: 2 }));
  const b = solveByPenalty(makeInput(shifted, { penalty: 2 }));
  assert.deepEqual(b.cuts, a.cuts);
  assert.ok(Math.abs(b.totalUnpenalizedCost - a.totalUnpenalizedCost) < 1e-6);
});

test("大基数小波动：稳定段成本不产生负 SSE，并恢复远小于均值的阶跃（1e12 上的 1e-3）", () => {
  const big = 1e12;
  const matrix = [
    ...Array.from({ length: 12 }, () => [big]),
    ...Array.from({ length: 12 }, () => [big + 1e-3]),
  ];
  const table = CostTable.build(matrix, [1], Number.MAX_SAFE_INTEGER);
  for (let a = 0; a < matrix.length; a++) {
    for (let b = a; b < matrix.length; b++) {
      for (const dc of table.segmentDimensionCosts(a, b, [1])) {
        assert.ok(dc.rawSSE >= 0, `负 SSE ${dc.rawSSE} at [${a},${b}]`);
      }
    }
  }
  const r = solveFixedK(makeInput(matrix), 2);
  assert.deepEqual(r.cuts, [12]);
  assert.equal(r.totalUnpenalizedCost, 0);
  assert.deepEqual(r.segments[1]!.mean, [big + 1e-3]);
});

test("特征权重与坐标缩放对应：x_j 放大 s 倍等价于权重乘 s²", () => {
  const base = [0, 0, 10, 10, 0, 0].map((v) => [v]);
  const scaled = base.map(([v]) => [v * 3]);
  const viaScale = solveByPenalty(makeInput(scaled, { weights: [1], penalty: 5 }));
  const viaWeight = solveByPenalty(makeInput(base, { weights: [9], penalty: 5 }));
  assert.deepEqual(viaScale.cuts, viaWeight.cuts);
  assert.ok(
    Math.abs(viaScale.totalUnpenalizedCost - viaWeight.totalUnpenalizedCost) < 1e-8,
  );
});

test("多维度不同尺度：权重为 0 的维度不影响切分", () => {
  const m1 = [0, 0, 0, 100, 100, 100].map((v) => [v, 0]);
  const m2 = m1.map(([a, b], i) => [a, i < 3 ? 50 : -50]);
  const r1 = solveByPenalty(makeInput(m1, { weights: [1, 0], penalty: 1 }));
  const r2 = solveByPenalty(makeInput(m2, { weights: [1, 0], penalty: 1 }));
  assert.deepEqual(r1.cuts, r2.cuts);
});

test("惩罚扫描：变点数随惩罚增加不增；切分可不嵌套", () => {
  const matrix = [0, 0, 5, 5, 0, 0, 5, 5, 0, 0].map((v) => [v]);
  const scan = scanPenalties(makeInput(matrix, { m: 2 }), [0, 1, 10, 100, 10000]);
  assert.equal(scan.complete, true);
  assert.equal(scan.monotoneNonincreasingChangepoints, true);
  for (let i = 1; i < scan.items.length; i++) {
    assert.ok(scan.items[i]!.changepoints <= scan.items[i - 1]!.changepoints);
  }
});

test("预算耗尽：只返回未完成，不声称为精确最优", () => {
  const matrix = Array.from({ length: 30 }, (_, i) => [i]);
  const r = solveByPenalty(makeInput(matrix, { budget: 100 }));
  assert.equal(r.complete, false);
  assert.equal(r.segments.length, 0);
  assert.ok(r.method.includes("未完成"));
});

test("独立核验：从原始样本重算并与求解结果一致", () => {
  const matrix = [1, 2, 10, 11, 20, 21].map((v) => [v]);
  const r = solveFixedK(makeInput(matrix), 3);
  const v = verifySegmentation(
    matrix,
    [1],
    1,
    r.cuts,
    r.totalUnpenalizedCost,
  );
  assert.equal(v.valid, true);
  assert.ok(Math.abs(v.recomputedUnpenalizedCost - r.totalUnpenalizedCost) < 1e-10);
});

test("输入校验：非有限值、重复时间、缺失维度、负权重均明确报错", () => {
  assert.throws(
    () => validateRows([{ timestamp: 0, values: [1, NaN] }]),
    ValidationError,
  );
  assert.throws(
    () =>
      validateRows([
        { timestamp: 1, values: [1] },
        { timestamp: 1, values: [2] },
      ]),
    ValidationError,
  );
  assert.throws(
    () =>
      validateRows([
        { timestamp: 0, values: [1, 2] },
        { timestamp: 1, values: [2] },
      ]),
    ValidationError,
  );
  assert.throws(() => validateWeights([1, -2], 2), ValidationError);
});
