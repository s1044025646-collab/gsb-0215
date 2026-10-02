import assert from 'node:assert/strict';
import { test } from 'node:test';
import { segmentCost, segmentResidualByDim } from '../src/cost.js';
import { fitWithPenalty, fitWithSegments } from '../src/dp.js';
import { verifySegmentation } from '../src/verify.js';
import { validateImport } from '../src/validate.js';
import { DEFAULT_BUDGET, type FitOk, type Sample } from '../src/types.js';

function series(values: number[] | number[][]): Sample[] {
  return (values as any[]).map((v, i) => ({
    t: i,
    values: Array.isArray(v) ? v : [v],
  }));
}

const W1 = [1];

test('常量序列：任意惩罚下成本为 0，平局选更少变点（1 段）', () => {
  const s = series([3, 3, 3, 3, 3, 3]);
  const r = fitWithPenalty(s, W1, 1, 0, DEFAULT_BUDGET) as FitOk;
  assert.equal(r.status, 'ok');
  assert.equal(r.changepoints.length, 0);
  assert.equal(r.unpenalizedCost, 0);
  assert.equal(r.objective, 0);
});

test('单次阶跃：变点落在阶跃处', () => {
  const s = series([0, 0, 0, 0, 0, 10, 10, 10, 10, 10]);
  const r = fitWithPenalty(s, W1, 1, 1, DEFAULT_BUDGET) as FitOk;
  assert.deepEqual(r.changepoints, [5]);
  assert.equal(r.unpenalizedCost, 0);
  assert.equal(r.penaltyTerm, 1);
  assert.equal(r.objective, 1);
});

test('短尖峰：最短段长排除独立成段', () => {
  const s = series([0, 0, 0, 0, 0, 99, 0, 0, 0, 0, 0]);
  const r = fitWithPenalty(s, W1, 3, 1, DEFAULT_BUDGET) as FitOk;
  // 尖峰长度 1 < minLen=3，不能被单独切出
  for (const seg of r.segments) assert.ok(seg.end - seg.start >= 3);
});

test('多维不同尺度：权重决定各维对目标的贡献', () => {
  const s = series([
    [0, 0],
    [0, 0],
    [0, 0],
    [1, 100],
    [1, 100],
    [1, 100],
  ]);
  // 小尺度维跳变 1（节省 1.5）低于惩罚 10 -> 不切
  const r0 = fitWithPenalty(s, [1, 0], 1, 10, DEFAULT_BUDGET) as FitOk;
  assert.deepEqual(r0.changepoints, []);
  const rNo = fitWithPenalty(s, [0, 1], 1, 10, DEFAULT_BUDGET) as FitOk;
  assert.deepEqual(rNo.changepoints, [3]); // 大维跳变 100，即使惩罚 10 也应切
  const rSkip = fitWithPenalty(s, [0, 1], 1, 1e9, DEFAULT_BUDGET) as FitOk;
  assert.deepEqual(rSkip.changepoints, []); // 巨大惩罚 -> 不切
});

test('最短段长卡边界：n=2L 时唯一合法切点在 L', () => {
  const s = series([0, 0, 0, 10, 10, 10]);
  const r = fitWithPenalty(s, W1, 3, 0.5, DEFAULT_BUDGET) as FitOk;
  assert.deepEqual(r.changepoints, [3]);
});

test('零惩罚 + 平局规则：常量序列仍选 1 段（更少变点优先）', () => {
  const s = series([1, 1, 1, 1]);
  const r = fitWithPenalty(s, W1, 1, 0, DEFAULT_BUDGET) as FitOk;
  assert.equal(r.segmentCount, 1);
});

test('大基数小波动：成本准确且平移不变', () => {
  const base = 1e12;
  const fluct = [0, 1, 0, -1, 2, -2, 0.5, -0.5];
  const values = fluct.map((f) => [base + f]);
  const cost = segmentCost(values, 0, values.length, W1);
  const ref = segmentCost(fluct.map((f) => [f]), 0, fluct.length, W1);
  assert.ok(Math.abs(cost - ref) < 1e-6 * Math.max(1, ref), `cost=${cost} ref=${ref}`);
  assert.ok(cost > 0);
});

test('平移不变性：整体加常数不改变拟合结果', () => {
  const a = series([0, 0, 0, 5, 5, 5, 1, 1, 1]);
  const b = series([1e9, 1e9, 1e9, 1e9 + 5, 1e9 + 5, 1e9 + 5, 1e9 + 1, 1e9 + 1, 1e9 + 1]);
  const ra = fitWithPenalty(a, W1, 1, 2, DEFAULT_BUDGET) as FitOk;
  const rb = fitWithPenalty(b, W1, 1, 2, DEFAULT_BUDGET) as FitOk;
  assert.deepEqual(ra.changepoints, rb.changepoints);
  assert.ok(Math.abs(ra.unpenalizedCost - rb.unpenalizedCost) < 1e-3);
});

test('特征权重 = 坐标缩放 sqrt(w) 的对应关系', () => {
  const vals = [[0], [1], [2], [3]];
  const w = 4;
  const weighted = segmentCost(vals, 0, 4, [w]);
  const scaled = segmentCost(vals.map((v) => [v[0] * Math.sqrt(w)]), 0, 4, [1]);
  assert.ok(Math.abs(weighted - scaled) < 1e-9);
});

test('成本分解：unpenalized + penalty * #cps = objective', () => {
  const s = series([0, 0, 0, 5, 5, 5, 0, 0, 0]);
  const r = fitWithPenalty(s, W1, 1, 2.5, DEFAULT_BUDGET) as FitOk;
  assert.equal(r.penaltyTerm, 2.5 * r.changepoints.length);
  assert.equal(r.objective, r.unpenalizedCost + r.penaltyTerm);
});

test('穷举核对：小序列所有合法切分 vs DP（目标与平局规则）', () => {
  const data = [0.3, -1.2, 0.8, 2.1, 1.9, 2.4, -0.7, 0.1];
  const s = series(data);
  const n = data.length;
  const minLen = 2;
  const penalty = 1.7;
  // 穷举
  let best: { obj: number; cps: number[] } | null = null;
  const total = 1 << (n - 1);
  for (let mask = 0; mask < total; mask++) {
    const cps: number[] = [];
    for (let b = 1; b < n; b++) if (mask & (1 << (b - 1))) cps.push(b);
    const bounds = [0, ...cps, n];
    let ok = true;
    let cost = 0;
    for (let k = 0; k + 1 < bounds.length; k++) {
      const len = bounds[k + 1] - bounds[k];
      if (len < minLen) {
        ok = false;
        break;
      }
      cost += segmentCost(s.map((x) => x.values), bounds[k], bounds[k + 1], W1);
    }
    if (!ok) continue;
    const obj = cost + penalty * cps.length;
    if (
      best === null ||
      obj < best.obj ||
      (obj === best.obj &&
        (cps.length < best.cps.length ||
          (cps.length === best.cps.length &&
            cps.join(',') < best.cps.join(','))))
    ) {
      best = { obj, cps };
    }
  }
  const r = fitWithPenalty(s, W1, minLen, penalty, DEFAULT_BUDGET) as FitOk;
  assert.equal(r.objective, best!.obj);
  assert.deepEqual(r.changepoints, best!.cps);
});

test('指定段数：精确 K 段且不可行拒绝', () => {
  const s = series([0, 0, 0, 5, 5, 5, 10, 10, 10]);
  const r = fitWithSegments(s, W1, 1, 3, DEFAULT_BUDGET) as FitOk;
  assert.deepEqual(r.changepoints, [3, 6]);
  assert.equal(r.segmentCount, 3);
  assert.throws(() => fitWithSegments(s, W1, 4, 3, DEFAULT_BUDGET), /不可行/);
  assert.throws(() => fitWithSegments(s, W1, 1, 0, DEFAULT_BUDGET));
});

test('指定段数与穷举一致', () => {
  const data = [1, 0, 2, 8, 9, 7, 3, 2];
  const s = series(data);
  const K = 3;
  const minLen = 2;
  const n = data.length;
  let best: { obj: number; cps: number[] } | null = null;
  const total = 1 << (n - 1);
  for (let mask = 0; mask < total; mask++) {
    const cps: number[] = [];
    for (let b = 1; b < n; b++) if (mask & (1 << (b - 1))) cps.push(b);
    if (cps.length !== K - 1) continue;
    const bounds = [0, ...cps, n];
    let ok = true;
    let cost = 0;
    for (let k = 0; k + 1 < bounds.length; k++) {
      if (bounds[k + 1] - bounds[k] < minLen) {
        ok = false;
        break;
      }
      cost += segmentCost(s.map((x) => x.values), bounds[k], bounds[k + 1], W1);
    }
    if (!ok) continue;
    if (best === null || cost < best.obj) best = { obj: cost, cps };
  }
  const r = fitWithSegments(s, W1, minLen, K, DEFAULT_BUDGET) as FitOk;
  assert.equal(r.unpenalizedCost, best!.obj);
  assert.deepEqual(r.changepoints, best!.cps);
});

test('核验接口：从原始样本重算给定分段，非法分段拒绝', () => {
  const s = series([0, 0, 0, 5, 5, 5]);
  const r = verifySegmentation(s, W1, 1, [3], 2);
  assert.equal(r.unpenalizedCost, 0);
  assert.equal(r.objective, 2);
  assert.deepEqual(r.segments[0].mean, [0]);
  assert.deepEqual(r.segments[1].mean, [5]);
  assert.throws(() => verifySegmentation(s, W1, 3, [1], null), /最短段长/);
  assert.throws(() => verifySegmentation(s, W1, 1, [0], null), /非法变点/);
});

test('预算超限返回未完成，不得冒充精确最优', () => {
  const s = series(Array.from({ length: 50 }, (_, i) => i % 7));
  const r = fitWithPenalty(s, W1, 1, 1, { maxCostCells: 10, maxDpTransitions: 10 });
  assert.equal(r.status, 'incomplete');
});

test('导入校验：非有限值/重复时间/缺失维度/负权重', () => {
  const cfg = { weights: [1], minSegmentLength: 1 };
  assert.throws(() => validateImport([{ t: 0, values: [NaN] }], cfg), /非有限/);
  assert.throws(
    () => validateImport([{ t: 1, values: [1] }, { t: 1, values: [2] }], cfg),
    /严格递增/,
  );
  assert.throws(() => validateImport([{ t: 0, values: [] }], cfg), /维度/);
  assert.throws(
    () => validateImport([{ t: 0, values: [1] }], { weights: [-1], minSegmentLength: 1 }),
    /非负/,
  );
  assert.throws(
    () => validateImport([{ t: 0, values: [1] }], { weights: [1], minSegmentLength: 0 }),
    /最短段长/,
  );
});

test('惩罚扫描单调性：变点数不随惩罚增加而增加', () => {
  const s = series([0, 0, 0, 5, 5, 5, 1, 1, 1, 9, 9, 9]);
  let prev = Infinity;
  for (const p of [0, 0.5, 2, 10, 100]) {
    const r = fitWithPenalty(s, W1, 1, p, DEFAULT_BUDGET) as FitOk;
    assert.ok(r.changepoints.length <= prev);
    prev = r.changepoints.length;
  }
});

test('每维残差与均值向量正确', () => {
  const s = series([
    [1, 10],
    [3, 20],
  ]);
  const rss = segmentResidualByDim(s.map((x) => x.values), 0, 2);
  assert.equal(rss[0], 2); // (1-2)^2+(3-2)^2
  assert.equal(rss[1], 50);
});
