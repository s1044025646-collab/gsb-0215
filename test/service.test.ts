import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Store } from "../src/db.js";
import { AnalysisService } from "../src/service.js";
import { FeasibilityError } from "../src/types.js";

const dir = resolve(tmpdir(), `cp-test-${process.pid}-${Date.now()}`);
let store: Store;
let service: AnalysisService;

before(() => {
  store = new Store(resolve(dir, "test.db"));
  service = new AnalysisService(store);
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function step(n: number): Array<{ timestamp: number; values: number[] }> {
  const rows: Array<{ timestamp: number; values: number[] }> = [];
  for (let i = 0; i < n; i++) {
    // 不等间隔时间戳：分析仍按样本计数。
    rows.push({ timestamp: i * i + 1, values: [i < n / 2 ? 0 : 8, i < n / 2 ? 0 : 4] });
  }
  return rows;
}

test("端到端：导入冻结 -> 拟合 -> 新配置版本 -> 比较 -> 报告不覆盖", () => {
  const imp = service.importDataset("step", step(20), { minSegmentLength: 2, penalty: 5 });
  assert.equal(imp.configVersion, 1);
  const fit = service.fitPenalty(imp.datasetId);
  assert.equal(fit.complete, true);
  assert.ok(fit.cuts.includes(10), `期望在样本 10 处变点，实际 ${JSON.stringify(fit.cuts)}`);

  const v2 = service.addConfigVersion(imp.datasetId, { minSegmentLength: 6 });
  assert.equal(v2, 2);
  const cmp = service.compareVersions(imp.datasetId, 1, 2);
  assert.equal(cmp.a.minSegmentLength, 2);
  assert.equal(cmp.b.minSegmentLength, 6);

  // 旧配置仍可复核（冻结不被覆盖）。
  const reverify = service.fitPenalty(imp.datasetId, { configVersion: 1 });
  assert.deepEqual(reverify.cuts, fit.cuts);

  service.saveReport(imp.datasetId, 1, "fit", "run-001", fit);
  assert.throws(
    () => service.saveReport(imp.datasetId, 1, "fit", "run-001", fit),
    /UNIQUE/,
  );
});

test("最短段长版本：变点被推出非法位置", () => {
  const imp = service.importDataset(
    "edge",
    [0, 0, 0, 10, 10, 10, 0, 0, 0].map((v, i) => ({ timestamp: i, values: [v] })),
    { minSegmentLength: 4, penalty: 1 },
  );
  // 3 段至少需要 12 样本，但 n=9 -> 拒绝。
  assert.throws(() => service.fitFixedK(imp.datasetId, 3), FeasibilityError);
  const fit = service.fitPenalty(imp.datasetId);
  for (const s of fit.segments) assert.ok(s.length >= 4);
});

test("外部分段核验拒绝越界与不连续切分", () => {
  const imp = service.importDataset(
    "verify",
    [1, 2, 3, 4, 5, 6].map((v, i) => ({ timestamp: i, values: [v] })),
  );
  const bad = service.verifyExternal(imp.datasetId, [0, 3]);
  assert.equal(bad.valid, false);
  const good = service.verifyExternal(imp.datasetId, [3]);
  assert.equal(good.valid, true);
  assert.equal(good.k, 2);
});
