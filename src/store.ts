import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { DatasetConfig, Sample } from './types.js';

export interface DatasetRow {
  id: number;
  name: string;
  createdAt: string;
}

export interface VersionRow {
  id: number;
  datasetId: number;
  version: number;
  config: DatasetConfig;
  createdAt: string;
}

/**
 * SQLite 持久化：数据集、版本（冻结配置与样本）、报告。
 * 报告只新增不覆盖，保证旧报告可复核。
 */
export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'cpsegment.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS datasets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id INTEGER NOT NULL REFERENCES datasets(id),
        version INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(dataset_id, version)
      );
      CREATE TABLE IF NOT EXISTS samples (
        version_id INTEGER NOT NULL REFERENCES versions(id),
        idx INTEGER NOT NULL,
        t REAL NOT NULL,
        values_json TEXT NOT NULL,
        PRIMARY KEY(version_id, idx)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES versions(id),
        kind TEXT NOT NULL,
        params_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createDataset(name: string): number {
    const stmt = this.db.prepare(
      'INSERT INTO datasets(name, created_at) VALUES (?, ?)',
    );
    const r = stmt.run(name, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  listDatasets(): DatasetRow[] {
    const rows = this.db
      .prepare('SELECT id, name, created_at AS createdAt FROM datasets ORDER BY id')
      .all() as unknown as DatasetRow[];
    return rows;
  }

  /** 追加一个新版本（不修改旧版本，数据冻结）。 */
  addVersion(datasetId: number, config: DatasetConfig, samples: Sample[]): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM versions WHERE dataset_id = ?')
      .get(datasetId) as { v: number | null };
    const version = (row.v ?? 0) + 1;
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        'INSERT INTO versions(dataset_id, version, config_json, created_at) VALUES (?,?,?,?)',
      )
      .run(datasetId, version, JSON.stringify(config), now);
    const versionId = Number(r.lastInsertRowid);
    const ins = this.db.prepare(
      'INSERT INTO samples(version_id, idx, t, values_json) VALUES (?,?,?,?)',
    );
    for (let i = 0; i < samples.length; i++) {
      ins.run(versionId, i, samples[i].t, JSON.stringify(samples[i].values));
    }
    return versionId;
  }

  getVersion(versionId: number): VersionRow | null {
    const row = this.db
      .prepare(
        'SELECT id, dataset_id AS datasetId, version, config_json AS configJson, created_at AS createdAt FROM versions WHERE id = ?',
      )
      .get(versionId) as
      | { id: number; datasetId: number; version: number; configJson: string; createdAt: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      datasetId: row.datasetId,
      version: row.version,
      config: JSON.parse(row.configJson),
      createdAt: row.createdAt,
    };
  }

  latestVersion(datasetId: number): VersionRow | null {
    const row = this.db
      .prepare(
        'SELECT id FROM versions WHERE dataset_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(datasetId) as { id: number } | undefined;
    return row ? this.getVersion(row.id) : null;
  }

  listVersions(datasetId: number): VersionRow[] {
    const rows = this.db
      .prepare(
        'SELECT id FROM versions WHERE dataset_id = ? ORDER BY version',
      )
      .all(datasetId) as unknown as { id: number }[];
    return rows.map((r) => this.getVersion(r.id)!);
  }

  getSamples(versionId: number): Sample[] {
    const rows = this.db
      .prepare(
        'SELECT t, values_json AS valuesJson FROM samples WHERE version_id = ? ORDER BY idx',
      )
      .all(versionId) as unknown as { t: number; valuesJson: string }[];
    return rows.map((r) => ({ t: r.t, values: JSON.parse(r.valuesJson) }));
  }

  /** 报告只插入、不更新不删除。 */
  addReport(
    versionId: number,
    kind: string,
    params: unknown,
    result: unknown,
  ): number {
    const r = this.db
      .prepare(
        'INSERT INTO reports(version_id, kind, params_json, result_json, created_at) VALUES (?,?,?,?,?)',
      )
      .run(
        versionId,
        kind,
        JSON.stringify(params),
        JSON.stringify(result),
        new Date().toISOString(),
      );
    return Number(r.lastInsertRowid);
  }

  getReport(id: number) {
    const row = this.db
      .prepare(
        'SELECT id, version_id AS versionId, kind, params_json AS paramsJson, result_json AS resultJson, created_at AS createdAt FROM reports WHERE id = ?',
      )
      .get(id) as
      | {
          id: number;
          versionId: number;
          kind: string;
          paramsJson: string;
          resultJson: string;
          createdAt: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      versionId: row.versionId,
      kind: row.kind,
      params: JSON.parse(row.paramsJson),
      result: JSON.parse(row.resultJson),
      createdAt: row.createdAt,
    };
  }

  listReports(versionId?: number) {
    const rows = (
      versionId === undefined
        ? this.db
            .prepare('SELECT id FROM reports ORDER BY id')
            .all()
        : this.db
            .prepare('SELECT id FROM reports WHERE version_id = ? ORDER BY id')
            .all(versionId)
    ) as unknown as { id: number }[];
    return rows.map((r) => this.getReport(r.id)!);
  }
}

/** 版本比较：配置差异 + 样本差异（数量、首个不同下标、时间戳与取值变化数）。 */
export function compareVersions(
  a: { config: DatasetConfig; samples: Sample[] },
  b: { config: DatasetConfig; samples: Sample[] },
) {
  const configDiff: string[] = [];
  const wa = a.config.weights;
  const wb = b.config.weights;
  if (wa.length !== wb.length) {
    configDiff.push(`权重维度 ${wa.length} -> ${wb.length}`);
  } else {
    for (let i = 0; i < wa.length; i++) {
      if (wa[i] !== wb[i]) configDiff.push(`权重[${i}] ${wa[i]} -> ${wb[i]}`);
    }
  }
  if (a.config.minSegmentLength !== b.config.minSegmentLength) {
    configDiff.push(
      `最短段长 ${a.config.minSegmentLength} -> ${b.config.minSegmentLength}`,
    );
  }
  const n = Math.min(a.samples.length, b.samples.length);
  let firstDiff: number | null = null;
  let tChanged = 0;
  let vChanged = 0;
  for (let i = 0; i < n; i++) {
    const sa = a.samples[i];
    const sb = b.samples[i];
    let diff = false;
    if (sa.t !== sb.t) {
      tChanged++;
      diff = true;
    }
    if (JSON.stringify(sa.values) !== JSON.stringify(sb.values)) {
      vChanged++;
      diff = true;
    }
    if (diff && firstDiff === null) firstDiff = i;
  }
  return {
    sampleCount: [a.samples.length, b.samples.length],
    configDiff,
    firstDifferingIndex: firstDiff,
    timestampsChanged: tChanged,
    valuesChanged: vChanged,
  };
}
