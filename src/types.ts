/** 单条样本：时间戳 + 各维度数值。时间戳仅用于排序与标识，不参与目标函数。 */
export interface Sample {
  t: number;
  values: number[];
}

/** 数据集配置。 */
export interface DatasetConfig {
  /** 每个维度的非负特征权重。 */
  weights: number[];
  /** 最短段长（样本数，>=1）。 */
  minSegmentLength: number;
}

/** 运算预算：超出后必须返回未完成，不得把部分结果标为精确最优。 */
export interface Budget {
  /** 允许计算的段成本单元数（约 O(n^2)）。 */
  maxCostCells: number;
  /** 允许的动态规划状态转移次数。 */
  maxDpTransitions: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxCostCells: 4_000_000,
  maxDpTransitions: 20_000_000,
};

/** 单个段的拟合结果。 */
export interface SegmentResult {
  /** 起始样本下标（含，0 基）。 */
  start: number;
  /** 结束样本下标（不含）。 */
  end: number;
  /** 段内均值向量。 */
  mean: number[];
  /** 每维加权前的残差平方和（该维度段内离差平方和）。 */
  residualByDim: number[];
  /** 该段加权残差平方和（未含惩罚）。 */
  cost: number;
}

export interface FitOk {
  status: 'ok';
  /** 变点：新段首个样本的下标（升序，不含 0）。 */
  changepoints: number[];
  segments: SegmentResult[];
  /** 各段加权残差平方和之和（未惩罚成本）。 */
  unpenalizedCost: number;
  /** 惩罚项 = penalty * 变点数。 */
  penaltyTerm: number;
  /** 总目标 = unpenalizedCost + penaltyTerm。 */
  objective: number;
  penalty: number | null;
  segmentCount: number;
}

export interface FitIncomplete {
  status: 'incomplete';
  reason: string;
}

export type FitResult = FitOk | FitIncomplete;
