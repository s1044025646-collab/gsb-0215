import { Store, type ConfigRow } from "./db.js";
import {
  scanPenalties,
  solveByPenalty,
  solveFixedK,
  verifySegmentation,
} from "./segmentation.js";
import type {
  AnalyzeConfig,
  PenaltyScanResult,
  SegmentationResult,
  VerifyResult,
} from "./types.js";
import { FeasibilityError, ValidationError } from "./types.js";
import {
  validateBudget,
  validateK,
  validateMinSegmentLength,
  validatePenalty,
  validateRows,
  validateWeights,
} from "./validation.js";

export interface ImportOptions {
  weights?: number[];
  minSegmentLength?: number;
  penalty?: number;
}

export interface ImportResult {
  datasetId: number;
  n: number;
  d: number;
  configVersion: number;
}

export class AnalysisService {
  constructor(private readonly store: Store) {}

  listDatasets() {
    return this.store.listDatasets();
  }

  /** 导入原始行并冻结为一个数据集 + 配置版本 1。 */
  importDataset(
    name: string,
    rawRows: Array<{ timestamp: unknown; values: unknown }>,
    opts: ImportOptions = {},
  ): ImportResult {
    if (typeof name !== "string" || name.trim() === "") {
      throw new ValidationError("数据集名称不能为空");
    }
    const { timestamps, matrix } = validateRows(rawRows);
    const d = matrix[0]!.length;
    const weights = validateWeights(
      opts.weights ?? new Array<number>(d).fill(1),
      d,
    );
    const minSegmentLength = validateMinSegmentLength(
      opts.minSegmentLength ?? 1,
      matrix.length,
    );
    const penalty = validatePenalty(opts.penalty ?? 0);

    const datasetId = this.store.createDataset(name, matrix.length, d);
    this.store.insertSamples(
      datasetId,
      matrix.map((values, i) => ({ timestamp: timestamps[i]!, values })),
    );
    const cfg: AnalyzeConfig = { weights, minSegmentLength, penalty };
    const configVersion = this.store.addConfig(datasetId, cfg);
    return { datasetId, n: matrix.length, d, configVersion };
  }

  /** 在冻结数据上新增一个配置版本（旧版本保留）。 */
  addConfigVersion(
    datasetId: number,
    patch: Partial<Pick<AnalyzeConfig, "weights" | "minSegmentLength" | "penalty">>,
  ): number {
    const ds = this.store.getDataset(datasetId);
    if (!ds) throw new ValidationError(`数据集 ${datasetId} 不存在`);
    const current = this.requireLatestConfig(datasetId);
    const weights =
      patch.weights !== undefined
        ? validateWeights(patch.weights, ds.d)
        : JSON.parse(current.weights_json) as number[];
    const minSegmentLength = validateMinSegmentLength(
      patch.minSegmentLength ?? current.min_segment_length,
      ds.n,
    );
    const penalty = validatePenalty(patch.penalty ?? current.penalty);
    return this.store.addConfig(datasetId, { weights, minSegmentLength, penalty });
  }

  private requireLatestConfig(datasetId: number): ConfigRow {
    const configs = this.store.listConfigs(datasetId);
    const latest = configs[configs.length - 1];
    if (!latest) throw new ValidationError(`数据集 ${datasetId} 没有任何配置版本`);
    return latest;
  }

  private load(datasetId: number, configVersion: number | undefined, budgetRaw?: number) {
    const ds = this.store.getDataset(datasetId);
    if (!ds) throw new ValidationError(`数据集 ${datasetId} 不存在`);
    const version = configVersion ?? this.requireLatestConfig(datasetId).version;
    const cfgRow = this.store.getConfig(datasetId, version);
    if (!cfgRow) throw new ValidationError(`配置版本 ${version} 不存在`);
    const weights = JSON.parse(cfgRow.weights_json) as number[];
    const { timestamps, matrix } = this.store.loadSamples(datasetId);
    return {
      ds,
      cfgRow,
      input: {
        datasetId,
        configVersion: version,
        timestamps,
        matrix,
        weights,
        minSegmentLength: cfgRow.min_segment_length,
        penalty: cfgRow.penalty,
        budget: validateBudget(budgetRaw),
      },
    };
  }

  /** 固定惩罚拟合（penalty 缺省取配置版本中冻结的值）。 */
  fitPenalty(
    datasetId: number,
    options: { configVersion?: number; penalty?: number; budget?: number } = {},
  ): SegmentationResult {
    const loaded = this.load(datasetId, options.configVersion, options.budget);
    const penalty =
      options.penalty === undefined ? loaded.input.penalty : validatePenalty(options.penalty);
    return solveByPenalty({ ...loaded.input, penalty });
  }

  /** 指定段数拟合；不可行段数抛出 FeasibilityError。 */
  fitFixedK(
    datasetId: number,
    kRaw: number,
    options: { configVersion?: number; budget?: number } = {},
  ): SegmentationResult {
    const k = validateK(kRaw);
    const loaded = this.load(datasetId, options.configVersion, options.budget);
    const minSegmentLength = loaded.input.minSegmentLength;
    const n = loaded.ds.n;
    const kMax = Math.floor(n / minSegmentLength);
    if (k > kMax) {
      throw new FeasibilityError(
        `段数 ${k} 不可行：n=${n}、最短段长=${minSegmentLength} 时最多 ${kMax} 段`,
      );
    }
    return solveFixedK({ ...loaded.input, penalty: 0 }, k);
  }

  scanPenalties(
    datasetId: number,
    penalties: number[],
    options: { configVersion?: number; budget?: number } = {},
  ): PenaltyScanResult {
    if (!Array.isArray(penalties) || penalties.length === 0) {
      throw new ValidationError("penalties 必须是非空数组");
    }
    penalties.forEach((p, i) => validatePenaltyAt(p, i));
    const loaded = this.load(datasetId, options.configVersion, options.budget);
    return scanPenalties(loaded.input, [...penalties].sort((a, b) => a - b));
  }

  /** 外部分段核验：从冻结的原始样本重新计算给定切分。 */
  verifyExternal(
    datasetId: number,
    cuts1Based: number[],
    options: { configVersion?: number; reportedUnpenalizedCost?: number } = {},
  ): VerifyResult {
    if (!Array.isArray(cuts1Based) || !cuts1Based.every((c) => Number.isInteger(c))) {
      throw new ValidationError("cuts 必须是整数数组（1 基末样本编号）");
    }
    const loaded = this.load(datasetId, options.configVersion);
    return verifySegmentation(
      loaded.input.matrix,
      loaded.input.weights,
      loaded.input.minSegmentLength,
      cuts1Based,
      options.reportedUnpenalizedCost,
    );
  }

  /** 保存报告，名称冲突拒绝（不覆盖旧报告）。 */
  saveReport(
    datasetId: number,
    configVersion: number,
    kind: string,
    name: string,
    payload: unknown,
  ): number {
    return this.store.saveReport(datasetId, configVersion, kind, name, payload);
  }

  /**
   * 版本比较：对两个配置版本在同一冻结数据上分别固定惩罚拟合，并排返回。
   * 权重/最短段长/惩罚的差异会体现在成本分解与切分中。
   */
  compareVersions(
    datasetId: number,
    versionA: number,
    versionB: number,
    options: { budget?: number } = {},
  ): { a: SegmentationResult; b: SegmentationResult } {
    return {
      a: this.fitPenalty(datasetId, { configVersion: versionA, budget: options.budget }),
      b: this.fitPenalty(datasetId, { configVersion: versionB, budget: options.budget }),
    };
  }
}

function validatePenaltyAt(p: number, i: number) {
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0) {
    throw new ValidationError(`第 ${i + 1} 个惩罚不是非负有限数`);
  }
}
