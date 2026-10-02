import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../src/db.js";
import { AnalysisService } from "../src/service.js";
import { segmentsToCSV, toJSON } from "../src/exporters.js";
import { writeFileSync } from "node:fs";

const dataDir = resolve(process.cwd(), "data", "demo");
rmSync(dataDir, { recursive: true, force: true });

function open() {
  const store = new Store(resolve(dataDir, "demo.db"));
  return { store, service: new AnalysisService(store) };
}

function line(t: string) {
  console.log("\n====================", t, "====================");
}

function main() {
  // 三个均值平台 + 一个短尖峰；不等间隔时间戳（平方），分析只按样本数。
  const rows: Array<{ timestamp: number; values: number[] }> = [];
  for (let i = 0; i < 30; i++) {
    let mean = 0;
    if (i >= 10 && i < 20) mean = 10;
    if (i >= 20) mean = 2;
    if (i === 15) mean = 40; // 短异常尖峰
    rows.push({ timestamp: i * i, values: [mean + ((i * 7) % 3) * 0.01, i * 0.1] });
  }

  let handle = open();
  const imp = handle.service.importDataset("demo-platforms", rows, {
    weights: [1, 0.2],
    minSegmentLength: 3,
  });
  line("导入（时间戳平方递增，允许不等间隔；不参与权重）");
  console.log(toJSON(imp));

  line("惩罚扫描：惩罚增大时段如何合并");
  const scan = handle.service.scanPenalties(imp.datasetId, [0, 0.1, 0.5, 2, 20, 500]);
  for (const item of scan.items) {
    console.log(
      `penalty=${item.penalty}\t段数=${item.k}\t变点=${item.changepoints}\t切分=${JSON.stringify(item.cuts)}\t目标=${item.totalObjective.toFixed(4)}`,
    );
  }
  console.log("单调性校验:", scan.monotoneNonincreasingChangepoints, "-", scan.note);

  line("低惩罚：尖峰被单独识别；高惩罚：尖峰被合并");
  const low = handle.service.fitPenalty(imp.datasetId, { penalty: 0.5 });
  const mid = handle.service.fitPenalty(imp.datasetId, { penalty: 2 });
  const high = handle.service.fitPenalty(imp.datasetId, { penalty: 500 });
  console.log("低惩罚切分:", low.cuts, " 段数:", low.k);
  console.log("中惩罚切分:", mid.cuts, " 段数:", mid.k);
  console.log("高惩罚切分:", high.cuts, " 段数:", high.k);

  line("最短段长排除的候选：尝试固定 15 段（需要 15*3=45 > 30 样本）");
  try {
    handle.service.fitFixedK(imp.datasetId, 15);
  } catch (e) {
    console.log("已拒绝:", (e as Error).message);
  }

  line("外部分段独立核验（从冻结原始样本重算）");
  const verify = handle.service.verifyExternal(imp.datasetId, low.cuts, {
    reportedUnpenalizedCost: low.totalUnpenalizedCost,
  });
  console.log(
    `valid=${verify.valid} 重算成本=${verify.recomputedUnpenalizedCost} 报告成本=${verify.reportedUnpenalizedCost}`,
  );

  line("版本比较：新增更短/更长的 minSegmentLength 版本");
  const v2 = handle.service.addConfigVersion(imp.datasetId, { minSegmentLength: 5 });
  // 零惩罚下版本 1 取到 K_max=10；版本 2 最短段长 5，K_max=6。
  console.log("v1 (min=3, penalty=0) 切分:", JSON.stringify(handle.service.fitPenalty(imp.datasetId, { configVersion: 1, penalty: 0 }).cuts));
  console.log("v2 (min=5, penalty=0) 切分:", JSON.stringify(handle.service.fitPenalty(imp.datasetId, { configVersion: v2, penalty: 0 }).cuts));
  const cmp = handle.service.compareVersions(imp.datasetId, 1, v2);
  console.log(`v1 min=${cmp.a.minSegmentLength} 切分=${JSON.stringify(cmp.a.cuts)}`);
  console.log(`v2 min=${cmp.b.minSegmentLength} 切分=${JSON.stringify(cmp.b.cuts)}`);

  const reportPath = resolve(dataDir, "segments-low-penalty.csv");
  writeFileSync(reportPath, segmentsToCSV(low), "utf-8");
  line("CSV 导出");
  console.log("已导出:", reportPath);

  handle.store.close();

  line("重启进程后复核（SQLite 冻结数据与配置）");
  handle = open();
  const reopened = handle.service.fitPenalty(imp.datasetId, { configVersion: 1, penalty: 0.5 });
  console.log("重开后切分:", reopened.cuts, " 与之前一致:", JSON.stringify(reopened.cuts) === JSON.stringify(low.cuts));
  handle.store.close();

  line("声明边界");
  console.log("检测到的变点仅是加权最小二乘目标下的最优分割点，不代表因果变化或统计显著。");
}

main();
