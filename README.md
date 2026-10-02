# cpsegment — 多变量序列离线变点与最优分段后端

纯后端（API + CLI），TypeScript + Node.js + SQLite，Windows 本地运行，
不依赖 Docker / WSL / 付费服务 / 外部在线 API。SQLite 使用 Node 内置
`node:sqlite`（Node ≥ 22.5，建议 ≥ 24），无原生编译依赖。

## 功能

- 按时间排序的多变量数值序列，全局最优动态规划分段：每段一个均值向量，
  目标 = 各段加权残差平方和 + 惩罚 × 变点数（变点数 = 段数 − 1）。
- 两种查询：固定非负惩罚 / 指定段数；首段、末段、中间段均受最短段长约束；
  不可行段数直接拒绝。
- 平局规则（公开、确定）：先比总目标，再选更少变点，再按变点位置列表字典序取靠前者。
- 数值稳定段成本：以段内首样本为平移基准累加，正确处理“大基数小波动”，
  不靠把负残差裁零掩盖精度问题（仅对 <1e-9 相对量级的舍入负值裁零，其余抛错）。
- 独立核验接口：从原始样本重算任意外部分段的均值、每维残差、成本分解。
- 惩罚扫描：一次比较多个惩罚；惩罚增大时最优变点数不会增加，
  但变点位置不必形成嵌套集合。
- 运算预算（段成本单元数 / DP 转移次数）：超限或中断只返回
  `status: "incomplete"`，绝不把部分结果标为精确最优。
- SQLite 冻结数据与配置（数据集 → 版本 → 样本），报告只新增不覆盖。
- JSON / CSV 导出；版本比较；可配置端口与项目内数据目录。

## 快速开始

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 构建并运行全部测试
npm start         # 启动 API（默认端口 3210，PORT 环境变量可改）
npm run demo      # 端到端演示（惩罚合并、最短段长排除、重启复核）
```

数据目录默认为项目内 `data/`（可用环境变量 `DATA_DIR` 覆盖），
数据库文件 `data/cpsegment.db`。

## API（HTTP，JSON）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/datasets` | 导入新数据集 `{name, samples:[{t,values}], config:{weights, minSegmentLength}}` |
| POST | `/datasets/:id/import` | 为已有数据集追加新版本（冻结旧版本） |
| GET | `/datasets` / `/datasets/:id/versions` | 列表 |
| POST | `/datasets/:id/fit` | 拟合 `{penalty}` 或 `{segments}`，可选 `{budget:{maxCostCells,maxDpTransitions}}` |
| POST | `/datasets/:id/scan` | 惩罚扫描 `{penalties:[...]}` |
| POST | `/datasets/:id/verify` | 核验外部分段 `{changepoints:[...], penalty?}` |
| GET | `/versions/:id/samples` | 读取冻结样本 |
| GET | `/versions/compare?a=1&b=2` | 版本比较 |
| GET | `/reports` / `/reports/:id` | 报告查询（只增不改） |
| GET | `/reports/:id/export?format=json\|csv` | 导出 |

## CLI

```powershell
npm run cli -- import data.json --name demo --weights 1,1 --min-len 5
npm run cli -- fit --dataset 1 --penalty 10
npm run cli -- fit --dataset 1 --segments 3
npm run cli -- scan --dataset 1 --penalties 0,1,10,100
npm run cli -- verify --dataset 1 --boundaries 20,40 --penalty 10
npm run cli -- compare --a 1 --b 2
npm run cli -- export --report 1 --format csv --out out.csv
npm run cli -- list
```

导入文件支持 JSON（`[{t, values}]` 或 `{samples:[...]}`）与 CSV（表头 `t,v0,v1,...`）。

## 关键假设与规则

- 目标按**样本**计算：允许不等间隔采样，时间间隔不作为权重；
  最短段长单位为样本数。时间戳仅要求严格递增，用于排序与标识。
- 导入校验：非有限值（NaN/Infinity）、重复或倒序时间、缺失维度、
  负特征权重均明确拒绝。
- 特征权重 `w` 等价于将该维坐标缩放 `sqrt(w)`（有测试保证）。
- 全局精确 DP，不用贪心/局部最大跳跃；复杂度约 O(n²·d + n²)，
  默认预算 `maxCostCells=4e6`、`maxDpTransitions=2e7`，可覆盖约 n≤2000。
- 检测到的变点只是均值结构变化的最优拟合位置，**不代表因果变化或统计显著**。

## 项目结构

```
src/cost.ts     数值稳定段成本与成本矩阵
src/dp.ts       全局最优 DP（固定惩罚 / 指定段数、平局规则、预算）
src/verify.ts   独立核验
src/validate.ts 导入校验
src/store.ts    SQLite 持久化（数据集/版本/样本/报告）
src/service.ts  API 与 CLI 共用的服务层
src/server.ts   HTTP API（node:http，可配置端口）
src/cli.ts      命令行
src/demo.ts     演示脚本
test/core.test.ts  测试（常量/阶跃/尖峰/多尺度/边界/零惩罚/大基数小波动/穷举核对等）
```

## 限制

- 精确 DP 为 O(n²) 量级，超大序列需调低规模或提高预算（预算内保证精确，
  超预算只返回未完成）。
- 仅离线批处理：无在线监控、告警规则或预测模型。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
