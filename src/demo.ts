import fs from 'node:fs';
import path from 'node:path';
import { Service } from './service.js';
import { Store } from './store.js';
import type { Sample } from './types.js';

/**
 * 演示：
 * 1. 构造含两个阶跃 + 一个短尖峰的二维序列；
 * 2. 惩罚扫描：惩罚增大时分段逐步合并；
 * 3. 展示被最短段长排除的候选（尖峰无法单独成段）；
 * 4. 关闭并重开数据库（模拟重启），从原始样本复核已保存的分段。
 */
const dataDir = path.join(process.cwd(), 'data');
const dbFile = path.join(dataDir, 'cpsegment.db');
if (fs.existsSync(dbFile)) fs.rmSync(dbFile);

function makeSamples(): Sample[] {
  const samples: Sample[] = [];
  for (let i = 0; i < 60; i++) {
    let v0 = 0;
    let v1 = 100;
    if (i >= 20) {
      v0 = 5;
      v1 = 100;
    }
    if (i >= 40) {
      v0 = 5;
      v1 = 130;
    }
    if (i === 30 || i === 31) v0 = 50; // 短尖峰（长度 2 < 最短段长 5）
    samples.push({ t: 1000 + i * 7, values: [v0, v1] }); // 不等间隔外的规则采样，间隔不参与目标
  }
  return samples;
}

const service = new Service(new Store(dataDir));
const imp = service.importDataset('demo', makeSamples(), {
  weights: [1, 1],
  minSegmentLength: 5,
});
console.log('导入:', imp);

console.log('\n== 惩罚扫描（惩罚增大 -> 分段合并）==');
const scan = service.scan({ datasetId: imp.datasetId, penalties: [0, 1, 10, 100, 10000] });
for (const run of scan.runs) {
  if (run.result.status === 'ok') {
    console.log(
      `penalty=${run.penalty}\t变点=[${run.result.changepoints}]\t目标=${run.result.objective.toFixed(3)}`,
    );
  } else {
    console.log(`penalty=${run.penalty}\t未完成: ${run.result.reason}`);
  }
}
console.log(scan.note);

console.log('\n== 被最短段长排除的候选 ==');
console.log('下标 30-31 的尖峰若单独成段长度仅 2 < minLen=5，任何含该段的切分均非法，已被 DP 排除。');
try {
  service.verify({ datasetId: imp.datasetId, changepoints: [30, 32] });
} catch (err) {
  console.log('核验拒绝非法分段:', err instanceof Error ? err.message : err);
}

console.log('\n== 模拟重启后复核 ==');
service.store.close();
const service2 = new Service(new Store(dataDir));
const fit = service2.fit({ datasetId: imp.datasetId, penalty: 10 });
if (fit.result.status === 'ok') {
  const check = service2.verify({
    datasetId: imp.datasetId,
    changepoints: fit.result.changepoints,
    penalty: 10,
  });
  console.log('拟合变点:', fit.result.changepoints, '目标:', fit.result.objective);
  console.log('复核目标:', check.result.objective, '一致:', check.result.objective === fit.result.objective);
}
console.log('\n注意：检测到的变点仅表示均值结构变化的最优拟合位置，不代表因果变化或统计显著。');
service2.store.close();
