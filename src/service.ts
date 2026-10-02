import { fitWithPenalty, fitWithSegments } from './dp.js';
import { compareVersions, Store } from './store.js';
import {
  DEFAULT_BUDGET,
  type Budget,
  type DatasetConfig,
  type FitResult,
  type Sample,
} from './types.js';
import { validateImport } from './validate.js';
import { verifySegmentation } from './verify.js';

export class Service {
  constructor(public store: Store) {}

  importDataset(
    name: string | null,
    samples: Sample[],
    config: DatasetConfig,
    datasetId?: number,
  ) {
    validateImport(samples, config);
    const id = datasetId ?? this.store.createDataset(name ?? 'dataset');
    const versionId = this.store.addVersion(id, config, samples);
    const version = this.store.getVersion(versionId)!;
    return { datasetId: id, versionId, version: version.version };
  }

  private load(versionId?: number, datasetId?: number) {
    const version =
      versionId !== undefined
        ? this.store.getVersion(versionId)
        : this.store.latestVersion(requireId(datasetId, 'datasetId'));
    if (!version) throw new Error('数据集/版本不存在');
    const samples = this.store.getSamples(version.id);
    return { version, samples };
  }

  fit(opts: {
    datasetId?: number;
    versionId?: number;
    penalty?: number;
    segments?: number;
    budget?: Partial<Budget>;
  }) {
    const { version, samples } = this.load(opts.versionId, opts.datasetId);
    const budget: Budget = { ...DEFAULT_BUDGET, ...opts.budget };
    const { weights, minSegmentLength } = version.config;
    let result: FitResult;
    let params: Record<string, unknown>;
    if (opts.segments !== undefined) {
      result = fitWithSegments(samples, weights, minSegmentLength, opts.segments, budget);
      params = { mode: 'segments', segments: opts.segments, budget };
    } else if (opts.penalty !== undefined) {
      result = fitWithPenalty(samples, weights, minSegmentLength, opts.penalty, budget);
      params = { mode: 'penalty', penalty: opts.penalty, budget };
    } else {
      throw new Error('必须提供 penalty 或 segments');
    }
    const reportId = this.store.addReport(version.id, 'fit', params, result);
    return { reportId, versionId: version.id, result };
  }

  scan(opts: {
    datasetId?: number;
    versionId?: number;
    penalties: number[];
    budget?: Partial<Budget>;
  }) {
    if (!Array.isArray(opts.penalties) || opts.penalties.length === 0) {
      throw new Error('penalties 不能为空');
    }
    const runs = opts.penalties.map((p) => ({
      penalty: p,
      ...this.fit({
        datasetId: opts.datasetId,
        versionId: opts.versionId,
        penalty: p,
        budget: opts.budget,
      }),
    }));
    const counts = runs.map((r) =>
      r.result.status === 'ok' ? r.result.changepoints.length : null,
    );
    let monotone = true;
    for (let i = 1; i < runs.length; i++) {
      const a = counts[i - 1];
      const b = counts[i];
      if (
        a !== null &&
        b !== null &&
        runs[i].penalty >= runs[i - 1].penalty &&
        b > a
      ) {
        monotone = false;
      }
    }
    const note =
      '惩罚增加时最优变点数量不会增加；但变点位置不必形成嵌套集合。' +
      (monotone
        ? '本次扫描满足该单调性。'
        : '警告：本次扫描出现违反单调性的结果（请检查输入）。');
    return { runs, monotoneChangepointCount: monotone, note };
  }

  verify(opts: {
    datasetId?: number;
    versionId?: number;
    changepoints: number[];
    penalty?: number | null;
  }) {
    const { version, samples } = this.load(opts.versionId, opts.datasetId);
    const { weights, minSegmentLength } = version.config;
    const result = verifySegmentation(
      samples,
      weights,
      minSegmentLength,
      opts.changepoints,
      opts.penalty ?? null,
    );
    const reportId = this.store.addReport(
      version.id,
      'verify',
      { changepoints: opts.changepoints, penalty: opts.penalty ?? null },
      result,
    );
    return { reportId, versionId: version.id, result };
  }

  compareVersions(versionIdA: number, versionIdB: number) {
    const a = this.store.getVersion(versionIdA);
    const b = this.store.getVersion(versionIdB);
    if (!a || !b) throw new Error('版本不存在');
    const diff = compareVersions(
      { config: a.config, samples: this.store.getSamples(a.id) },
      { config: b.config, samples: this.store.getSamples(b.id) },
    );
    return {
      a: { versionId: a.id, datasetId: a.datasetId, version: a.version },
      b: { versionId: b.id, datasetId: b.datasetId, version: b.version },
      diff,
    };
  }

  exportReport(reportId: number, format: 'json' | 'csv'): string {
    const report = this.store.getReport(reportId);
    if (!report) throw new Error(`报告 ${reportId} 不存在`);
    if (format === 'json') return JSON.stringify(report, null, 2);
    const r = report.result as any;
    if (r?.status !== 'ok' || !Array.isArray(r.segments)) {
      throw new Error('该报告不是成功拟合结果，无法导出 CSV');
    }
    const dim = r.segments[0].mean.length;
    const header = [
      'segment',
      'start',
      'end',
      ...Array.from({ length: dim }, (_, d) => `mean_${d}`),
      ...Array.from({ length: dim }, (_, d) => `residual_${d}`),
      'cost',
    ];
    const lines = [header.join(',')];
    r.segments.forEach((s: any, i: number) => {
      lines.push(
        [i, s.start, s.end, ...s.mean, ...s.residualByDim, s.cost].join(','),
      );
    });
    lines.push('');
    lines.push(`unpenalized_cost,${r.unpenalizedCost}`);
    lines.push(`penalty_term,${r.penaltyTerm}`);
    lines.push(`objective,${r.objective}`);
    lines.push(`changepoints,"${r.changepoints.join(' ')}"`);
    return lines.join('\n');
  }
}

function requireId(id: number | undefined, name: string): number {
  if (id === undefined) throw new Error(`缺少 ${name}`);
  return id;
}
