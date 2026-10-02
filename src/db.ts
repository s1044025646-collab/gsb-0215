import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AnalyzeConfig } from "./types.js";

export interface DatasetRow {
  id: number;
  name: string;
  n: number;
  d: number;
  created_at: string;
}

export interface SampleRow {
  dataset_id: number;
  row_id: number;
  sample_index: number;
  timestamp: number;
  values_json: string;
}

export interface ConfigRow {
  id: number;
  dataset_id: number;
  version: number;
  weights_json: string;
  min_segment_length: number;
  penalty: number;
  created_at: string;
}

export interface ReportRow {
  id: number;
  dataset_id: number;
  config_version: number;
  kind: string;
  name: string;
  payload_json: string;
  created_at: string;
}

/**
 * SQLite 持久层。数据集与配置只增不改（冻结）；报告以唯一名称保存，
 * 名称冲突时拒绝而非覆盖旧报告。
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        n INTEGER NOT NULL,
        d INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS samples (
        dataset_id INTEGER NOT NULL REFERENCES datasets(id),
        row_id INTEGER NOT NULL,
        sample_index INTEGER NOT NULL,
        timestamp REAL NOT NULL,
        values_json TEXT NOT NULL,
        PRIMARY KEY (dataset_id, row_id)
      );
      CREATE TABLE IF NOT EXISTS configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id INTEGER NOT NULL REFERENCES datasets(id),
        version INTEGER NOT NULL,
        weights_json TEXT NOT NULL,
        min_segment_length INTEGER NOT NULL,
        penalty REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (dataset_id, version)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id INTEGER NOT NULL REFERENCES datasets(id),
        config_version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  createDataset(name: string, n: number, d: number): number {
    const stmt = this.db.prepare("INSERT INTO datasets(name, n, d) VALUES (?, ?, ?)");
    const res = stmt.run(name, n, d);
    return Number(res.lastInsertRowid);
  }

  listDatasets(): DatasetRow[] {
    return this.db
      .prepare("SELECT id, name, n, d, created_at FROM datasets ORDER BY id")
      .all() as unknown as DatasetRow[];
  }

  getDataset(id: number): DatasetRow | undefined {
    return this.db
      .prepare("SELECT id, name, n, d, created_at FROM datasets WHERE id = ?")
      .get(id) as unknown as DatasetRow | undefined;
  }

  insertSamples(
    datasetId: number,
    rows: Array<{ timestamp: number; values: number[] }>,
  ): void {
    const stmt = this.db.prepare(
      "INSERT INTO samples(dataset_id, row_id, sample_index, timestamp, values_json) VALUES (?, ?, ?, ?, ?)",
    );
    const tx = this.db;
    tx.exec("BEGIN");
    try {
      rows.forEach((r, i) => {
        stmt.run(datasetId, i, i + 1, r.timestamp, JSON.stringify(r.values));
      });
      tx.exec("COMMIT");
    } catch (e) {
      tx.exec("ROLLBACK");
      throw e;
    }
  }

  loadSamples(datasetId: number): { timestamps: number[]; matrix: number[][] } {
    const rows = this.db
      .prepare(
        "SELECT timestamp, values_json FROM samples WHERE dataset_id = ? ORDER BY row_id",
      )
      .all(datasetId) as unknown as Array<{ timestamp: number; values_json: string }>;
    return {
      timestamps: rows.map((r) => r.timestamp),
      matrix: rows.map((r) => JSON.parse(r.values_json) as number[]),
    };
  }

  /** 新增配置版本（不修改旧版本）。版本号在数据集内递增。 */
  addConfig(datasetId: number, cfg: AnalyzeConfig): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM configs WHERE dataset_id = ?")
      .get(datasetId) as unknown as { v: number };
    const version = row.v + 1;
    this.db
      .prepare(
        "INSERT INTO configs(dataset_id, version, weights_json, min_segment_length, penalty) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        datasetId,
        version,
        JSON.stringify(cfg.weights),
        cfg.minSegmentLength,
        cfg.penalty,
      );
    return version;
  }

  getConfig(datasetId: number, version: number): ConfigRow | undefined {
    return this.db
      .prepare(
        "SELECT id, dataset_id, version, weights_json, min_segment_length, penalty, created_at FROM configs WHERE dataset_id = ? AND version = ?",
      )
      .get(datasetId, version) as unknown as ConfigRow | undefined;
  }

  listConfigs(datasetId: number): ConfigRow[] {
    return this.db
      .prepare(
        "SELECT id, dataset_id, version, weights_json, min_segment_length, penalty, created_at FROM configs WHERE dataset_id = ? ORDER BY version",
      )
      .all(datasetId) as unknown as ConfigRow[];
  }

  /** 保存报告；名称冲突直接抛错，绝不覆盖旧报告。 */
  saveReport(
    datasetId: number,
    configVersion: number,
    kind: string,
    name: string,
    payload: unknown,
  ): number {
    const stmt = this.db.prepare(
      "INSERT INTO reports(dataset_id, config_version, kind, name, payload_json) VALUES (?, ?, ?, ?, ?)",
    );
    const res = stmt.run(datasetId, configVersion, kind, name, JSON.stringify(payload));
    return Number(res.lastInsertRowid);
  }

  listReports(datasetId?: number): ReportRow[] {
    if (datasetId === undefined) {
      return this.db
        .prepare("SELECT * FROM reports ORDER BY id")
        .all() as unknown as ReportRow[];
    }
    return this.db
      .prepare("SELECT * FROM reports WHERE dataset_id = ? ORDER BY id")
      .all(datasetId) as unknown as ReportRow[];
  }

  getReportByName(name: string): ReportRow | undefined {
    return this.db
      .prepare("SELECT * FROM reports WHERE name = ?")
      .get(name) as unknown as ReportRow | undefined;
  }
}
