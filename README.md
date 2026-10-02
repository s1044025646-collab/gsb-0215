# 多变量序列离线变点与最优分段后端

按时间排序的多变量数值序列分析服务：把完整序列一次性划分为若干段，每段用一个均值向量拟合，
寻找均值结构变化的位置（均值漂移变点）。只提供 **HTTP API 与 CLI**，不含前端、在线监控、
告警规则或预测模型。

- 语言/运行时：TypeScript + Node.js（建议 Node ≥ 22.5，开发环境为 Node 25）
- 存储：SQLite（使用 Node 内置的 `node:sqlite`，**零第三方运行时依赖**）
- 本地离线运行，不需要 Docker、WSL、付费服务或外部在线 API

## 1. 问题定义与目标函数

设序列为 `n` 个样本、`d` 个维度，样本编号 `1..n`，允许时间戳不等间隔。
将序列分为 `K` 段，段内每维拟合一个常数（该维均值）。目标为

```
Obj = Σ_{段 s} Σ_{j=1..d} w_j · Σ_{i∈s} (x_ij − mean_sj)²  +  penalty · (K − 1)
```

- `w_j ≥ 0` 为特征权重（`0` 表示忽略该维）；所有权重在同一段内对每个样本恒定为 1。
- **最短段长按样本数计**，对首段、末段及全部中间段使用同一约束 `length ≥ minSegmentLength`。
- 变点数 = 段数 − 1。
- 时间戳只用于排序与展示，**绝不把时间间隔当作权重或采样率**。
- 支持两种查询：固定非负 `penalty`（自动选段数），或指定段数 `K`。

求解使用**全局最优动态规划**（Bellman 递推），不是贪心找最大跳跃：

```
dp_1[b] = C(0, b)
dp_k[b] = min_s { dp_{k-1}[s] + C(s+1, b) }
```

其中 `C(a,b)` 为区间 `[a,b]` 的加权残差平方和，`s` 的取值同时保证前 `k-1` 段与末段长度都
≥ 最短段长。一次 DP 即可得到所有可行段数 `K = 1..floor(n/m)` 的最优解，固定惩罚与惩罚
扫描复用同一结果。不可行段数（`K·m > n`）直接拒绝（HTTP 422）。

**平局规则（公开、确定、可复现）**：目标值相同时先取更少变点（更小 `K`）；段数也相同时，
取切分位置元组（前 `K-1` 段末样本编号序列）字典序最小者。

### 数值稳定性

段成本在“以段首样本为原点的平移空间”内递推（方差对常量平移严格不变），并用
Neumaier 补偿求和累加二阶矩，避免 `Σx² − (Σx)²/n` 这类大数相减。处理“1e12 基值 +
远小于均值的阶跃”这类序列时不会把负残差裁成零来掩盖精度问题（IEEE-754 双精度的物理
极限仍然存在：当波动小于基值的 ulp 时无法区分，这是浮点数本身的限制）。

## 2. 数据校验（明确拒绝，不静默处理）

- 非有限值（`NaN` / `Infinity` / `-Infinity`）→ 报错
- 时间戳非有限、重复或非严格递增 → 报错
- 任一样本缺失维度（维度数与首行不一致）→ 报错
- 负权重 / 非有限权重 → 报错
- 最短段长非正整数或大于样本数 → 报错
- 惩罚为负或非有限 → 报错

## 3. 安装与构建

```powershell
npm install
npm run build
```

`node:sqlite` 在当前 Node 版本需要 `--experimental-sqlite` 标志（脚本已内置，无需手加）。

## 4. 测试

```powershell
npm test
```

测试覆盖（19 个用例）：常量序列、单次阶跃、短异常尖峰、多维不同尺度、最短段长卡边界、
零惩罚、大基数小波动；并用小序列**位掩码穷举所有合法切分**核对 DP 的目标值与平局规则；
还验证了成本分解自洽、平移不变、“坐标放大 s 倍 ⇔ 权重乘 s²”的对应关系、预算中断语义，
以及基于 SQLite 的冻结/版本/报告端到端流程。

## 5. 启动 HTTP 服务

```powershell
# 开发方式（tsx 直跑）
npm run dev

# 或构建后运行
npm run build
npm start
```

环境变量：

- `PORT`：监听端口，默认 `8787`
- `DATA_DIR`：项目内数据目录（存放 SQLite 文件与导出），默认 `./data`

```powershell
$env:PORT="9000"; $env:DATA_DIR="E:\GSB\0215\B\data"; npm run dev
```

### API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/datasets` | 导入样本并冻结为数据集 + 配置版本 1 |
| GET | `/api/datasets` | 列出数据集 |
| POST | `/api/datasets/:id/configs` | 新增配置版本（不改旧版本） |
| POST | `/api/datasets/:id/fit` | 拟合：带 `k` 为指定段数，否则按 `penalty` |
| POST | `/api/datasets/:id/scan` | 一组惩罚下的最优解扫描 |
| POST | `/api/datasets/:id/verify` | 从冻结原始样本独立重算外部给定切分 |
| POST | `/api/datasets/:id/compare` | 两个配置版本的结果比较 |
| POST | `/api/datasets/:id/export` | JSON（默认）或 `{"format":"csv"}` 导出 |
| POST | `/api/datasets/:id/reports` | 命名保存报告（重名拒绝，不覆盖） |
| GET | `/api/reports` | 列出报告 |

导入请求体：

```json
{
  "name": "step",
  "minSegmentLength": 2,
  "penalty": 3,
  "weights": [1, 0.5],
  "rows": [
    { "timestamp": 0, "values": [0, 0] },
    { "timestamp": 5, "values": [0, 0] },
    { "timestamp": 9, "values": [9, 18] }
  ]
}
```

拟合请求体（可选 `configVersion`、`penalty`、`k`、`budget`）：

```json
{ "penalty": 3, "budget": 2000000 }
```

核验请求体：

```json
{ "cuts": [10, 25], "reportedUnpenalizedCost": 12.5 }
```

`cuts` 为 1 基末样本编号（变点位置），可不提供报告成本，仅重算并校验结构合法性。

### 响应字段（fit）

`segments[]` 每段含：闭区间样本编号/时间戳、长度、均值向量 `mean`、每维
`dimensionCosts`（原始 SSE、权重、加权 SSE）、`unpenalizedCost`；顶层含
`cuts`、`changepoints`、`totalUnpenalizedCost`、`penaltyTerm`、`totalObjective`、
`complete`、`budget`、`operationsUsed` 与 `method`。

## 6. CLI

```powershell
npm run cli -- help

# JSON 或 CSV(timestamp,dim_1,dim_2,...) 导入
npm run cli -- import --file data/sample.json --name step --weights 1,0.5 --min 2 --penalty 3
npm run cli -- list

# 固定惩罚 / 指定段数 / JSON / CSV 导出到文件
npm run cli -- fit 1 --penalty 3
npm run cli -- fit 1 --k 2 --config 1 --budget 2000000 --format csv --out seg.csv

# 惩罚扫描、外部核验、版本比较、新版本
npm run cli -- scan 1 --penalties 0,1,10,100
npm run cli -- verify 1 --cuts 4 --reported-cost 0
npm run cli -- add-config 1 --min 3 --penalty 5
npm run cli -- compare 1 --a 1 --b 2
npm run cli -- export-samples 1 --out samples.csv

# 命名报告（重名拒绝，不覆盖旧报告）
npm run cli -- report 1 --config 1 --name run-001
```

## 7. 惩罚扫描的理论性质

对同一数据，惩罚 `λ` 增大时最优变点数**不会增加**（扫描结果会显式校验该单调性）：
设 `K_λ` 最优，对 `λ' > λ` 与任意 `K' > K_λ` 可由两项目标的优劣关系推出 `K'` 不可能更优。
但不同惩罚下的**切分位置不必形成嵌套集合**，这是正常现象，代码与响应中均有说明。

## 8. 预算与“未完成”语义

`budget` 指允许的运算次数（区间成本评估与 DP 转移合计）。超限后响应 `complete=false`、
HTTP 状态 409（CLI 退出码 1），**只返回未完成信息，不返回任何已搜索分段**，绝不把部分搜索
标记为精确最优。成本表与 DP 均为 `O(n²)` 量级内存、`O(n²·K)` 量级时间（`K ≤ n/m`），
请据机器规模设置预算。

## 9. 冻结、版本与报告

- 数据集（样本）导入后只增不改；配置（权重、最短段长、惩罚）以版本号追加，旧版本保留。
- 报告必须命名且名称唯一，冲突时拒绝（SQLite `UNIQUE`），**不覆盖旧报告**。
- 重启进程后对同一冻结数据 + 同一配置版本得到完全一致的结果（演示脚本会验证）。

## 10. 演示

```powershell
npm run demo
```

演示内容：惩罚增大时分段如何逐级合并；尝试不可行段数被最短段长拒绝；外部分段独立核验；
不同最短段长版本的比较与被排除的候选；CSV 导出；以及“重启进程后复核结果一致”。

## 11. 重要声明与限制

- 检测到的变点仅是**给定加权最小二乘目标下的最优分割点**，不能声称为因果变化，也不代表
  统计显著（无 p 值、无分布假设检验）。
- 均值漂移模型不适用于趋势/方差变化等其他变点类型；段内模型为各维常数均值。
- 单线程 Node 实现，面向中小规模离线分析；超大 `n` 请通过 `budget` 控制规模。
- 双精度浮点存在物理精度极限（见“数值稳定性”）。
