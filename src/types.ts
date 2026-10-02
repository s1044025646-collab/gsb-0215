/**
 * 公共类型定义。
 *
 * 约定：
 * - 样本按输入顺序编号（1 起始，见 sampleIndex）；数据库行另有整数 id（0 起始）。
 * - 时间戳可为任意可比较的数值（支持不等间隔），但分析只按样本计数，
 *   绝不把时间间隔当作权重。
 * - 数据矩阵为 n 行 d 列（行列均不可缺）。
 */

/** 一条多变量样本：时间戳 + 各维数值。 */
export interface Sample {
  /** 1 起始的样本编号（展示/切分位置使用）。 */
  sampleIndex: number;
  /** 数值时间戳（毫秒或任意单位），序列内严格递增。 */
  timestamp: number;
  /** 各维取值，长度必须等于维度数且全部为有限数。 */
  values: number[];
}

/** 分析配置（导入时冻结，后续拟合只引用版本，不就地修改）。 */
export interface AnalyzeConfig {
  /** 各维非负特征权重，长度必须等于维度数。 */
  weights: number[];
  /** 最短段长（按样本数计），>=1，对首段、末段及所有中间段同样生效。 */
  minSegmentLength: number;
  /** 固定非负变点惩罚值（penalty 模式使用）。 */
  penalty: number;
}

/** 单个维度的成本分解（已乘权重）。 */
export interface DimensionCost {
  dimension: number;
  weight: number;
  /** 该维原始（未乘权重）残差平方和。 */
  rawSSE: number;
  /** weight * rawSSE。 */
  weightedSSE: number;
}

/** 一个段的完整结果。 */
export interface Segment {
  segmentIndex: number;
  /** 闭区间，使用 1 起始样本编号。 */
  startSampleIndex: number;
  endSampleIndex: number;
  length: number;
  startTimestamp: number;
  endTimestamp: number;
  /** 各维均值（特征权重不改变均值，因为每一样本权重恒为 1）。 */
  mean: number[];
  dimensionCosts: DimensionCost[];
  unpenalizedCost: number;
}

/** 一次分段求解的完整结果。 */
export interface SegmentationResult {
  datasetId: number;
  configVersion: number;
  mode: "penalty" | "fixedK";
  penalty: number;
  requestedK: number | null;
  n: number;
  d: number;
  minSegmentLength: number;
  segments: Segment[];
  k: number;
  /** 变点数 = K - 1。 */
  changepoints: number;
  /** 切分位置：前 K-1 段各自的末样本编号（1 起始），严格递增。 */
  cuts: number[];
  totalUnpenalizedCost: number;
  penaltyTerm: number;
  totalObjective: number;
  /** 是否在预算内完成精确全局求解。 */
  complete: boolean;
  budget: number;
  operationsUsed: number;
  method: string;
}

export interface PenaltyScanItem {
  penalty: number;
  k: number;
  changepoints: number;
  cuts: number[];
  totalUnpenalizedCost: number;
  penaltyTerm: number;
  totalObjective: number;
}

export interface PenaltyScanResult {
  datasetId: number;
  configVersion: number;
  n: number;
  d: number;
  minSegmentLength: number;
  minK: number;
  maxK: number;
  items: PenaltyScanItem[];
  complete: boolean;
  budget: number;
  operationsUsed: number;
  monotoneNonincreasingChangepoints: boolean;
  note: string;
}

export interface VerifyResult {
  valid: boolean;
  reasons: string[];
  n: number;
  d: number;
  k: number;
  cuts: number[];
  recomputedUnpenalizedCost: number;
  reportedUnpenalizedCost: number | null;
  objective: number | null;
  segments: Array<{
    startSampleIndex: number;
    endSampleIndex: number;
    length: number;
    mean: number[];
    unpenalizedCost: number;
    dimensionCosts: DimensionCost[];
  }>;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class FeasibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeasibilityError";
  }
}

export class BudgetExceededError extends Error {
  /** 到中断时已消耗的评估次数（中断结果绝不标记为精确最优）。 */
  operationsUsed: number;
  constructor(message: string, operationsUsed: number) {
    super(message);
    this.name = "BudgetExceededError";
    this.operationsUsed = operationsUsed;
  }
}
