#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "./db.js";
import { AnalysisService } from "./service.js";
import { segmentsToCSV, samplesToCSV, toJSON } from "./exporters.js";
import {
  BudgetExceededError,
  FeasibilityError,
  ValidationError,
  type SegmentationResult,
} from "./types.js";

const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(resolve(DATA_DIR, "changepoint.db"));
const service = new AnalysisService(store);

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ValidationError(`参数 --${name} 必须是数值`);
  return n;
}

function parseCsv(text: string): Array<{ timestamp: number; values: number[] }> {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) throw new ValidationError("CSV 至少包含表头和一行数据");
  const header = lines[0]!.split(",");
  if (header[0]?.trim() !== "timestamp") {
    throw new ValidationError("CSV 第一列必须是 timestamp（其余列为 dim_1..dim_d）");
  }
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const timestamp = Number(cells[0]);
    const values = cells.slice(1).map(Number);
    return { timestamp, values };
  });
}

function print(result: SegmentationResult, format: string | undefined, out: string | undefined) {
  let content: string;
  if (format === "csv") content = segmentsToCSV(result);
  else content = toJSON(result);
  if (out) {
    writeFileSync(out, content, "utf-8");
    console.log(`已写入 ${out}`);
  } else {
    console.log(content);
  }
}

const HELP = `多变量序列离线变点与最优分段 CLI

用法:
  cli import --file data.json [--name 名称] [--weights 1,1] [--min 2] [--penalty 10]
  cli list
  cli fit <datasetId> [--config 1] [--penalty 10] [--k 3] [--budget 1000000] [--format json|csv] [--out report.json]
  cli scan <datasetId> --penalties 0,5,10,50 [--config 1]
  cli verify <datasetId> --cuts 10,25 [--config 1] [--reported-cost 12.5]
  cli compare <datasetId> --a 1 --b 2
  cli add-config <datasetId> [--weights 1,2] [--min 3] [--penalty 5]
  cli export-samples <datasetId> [--out samples.csv]
  cli report <datasetId> --config 1 --kind fit --name run-001 [--penalty 10]

JSON 导入格式: { "name"?: string, "rows": [ { "timestamp": 0, "values": [1,2] } ] }
CSV 导入格式: timestamp,dim_1,dim_2 （首行表头，不允许空单元）

注意: 检测到的变点不代表因果变化或统计显著。`;

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd || cmd === "help" || flags.help) {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "import": {
      const file = flags.file;
      if (!file) throw new ValidationError("import 需要 --file");
      const text = readFileSync(file, "utf-8");
      let rows: Array<{ timestamp: number; values: number[] }>;
      let jsonName: string | undefined;
      if (file.toLowerCase().endsWith(".csv")) {
        rows = parseCsv(text);
      } else {
        const body = JSON.parse(text) as {
          name?: string;
          rows: Array<{ timestamp: number; values: number[] }>;
        };
        rows = body.rows;
        jsonName = body.name;
      }
      const created = service.importDataset(flags.name ?? jsonName ?? "dataset", rows, {
        weights: flags.weights ? flags.weights.split(",").map(Number) : undefined,
        minSegmentLength: num(flags.min, "min"),
        penalty: num(flags.penalty, "penalty"),
      });
      console.log(toJSON(created));
      break;
    }
    case "list":
      console.log(toJSON(service.listDatasets()));
      break;
    case "fit": {
      const datasetId = Number(positional[1]);
      const k = num(flags.k, "k");
      const budget = num(flags.budget, "budget");
      const result =
        k !== undefined
          ? service.fitFixedK(datasetId, k, { configVersion: num(flags.config, "config"), budget })
          : service.fitPenalty(datasetId, {
              configVersion: num(flags.config, "config"),
              penalty: num(flags.penalty, "penalty"),
              budget,
            });
      print(result, flags.format, flags.out);
      break;
    }
    case "scan": {
      const datasetId = Number(positional[1]);
      if (!flags.penalties) throw new ValidationError("scan 需要 --penalties 0,5,10");
      const penalties = flags.penalties.split(",").map(Number);
      console.log(
        toJSON(
          service.scanPenalties(datasetId, penalties, {
            configVersion: num(flags.config, "config"),
            budget: num(flags.budget, "budget"),
          }),
        ),
      );
      break;
    }
    case "verify": {
      const datasetId = Number(positional[1]);
      if (!flags.cuts) throw new ValidationError("verify 需要 --cuts 10,25");
      const cuts = flags.cuts.split(",").map(Number);
      console.log(
        toJSON(
          service.verifyExternal(datasetId, cuts, {
            configVersion: num(flags.config, "config"),
            reportedUnpenalizedCost: num(flags["reported-cost"], "reported-cost"),
          }),
        ),
      );
      break;
    }
    case "compare": {
      const datasetId = Number(positional[1]);
      const a = num(flags.a, "a");
      const b = num(flags.b, "b");
      if (!a || !b) throw new ValidationError("compare 需要 --a 与 --b 两个版本号");
      console.log(
        toJSON(
          service.compareVersions(datasetId, a, b, { budget: num(flags.budget, "budget") }),
        ),
      );
      break;
    }
    case "add-config": {
      const datasetId = Number(positional[1]);
      const version = service.addConfigVersion(datasetId, {
        weights: flags.weights ? flags.weights.split(",").map(Number) : undefined,
        minSegmentLength: num(flags.min, "min"),
        penalty: num(flags.penalty, "penalty"),
      });
      console.log(toJSON({ datasetId, configVersion: version }));
      break;
    }
    case "export-samples": {
      const datasetId = Number(positional[1]);
      const { timestamps, matrix } = store.loadSamples(datasetId);
      const csv = samplesToCSV(timestamps, matrix);
      if (flags.out) writeFileSync(flags.out, csv, "utf-8");
      else console.log(csv);
      break;
    }
    case "report": {
      const datasetId = Number(positional[1]);
      const configVersion = num(flags.config, "config");
      if (!configVersion) throw new ValidationError("report 需要 --config");
      if (!flags.name) throw new ValidationError("report 需要唯一 --name（重名拒绝，不覆盖）");
      const result = service.fitPenalty(datasetId, {
        configVersion,
        penalty: num(flags.penalty, "penalty"),
        budget: num(flags.budget, "budget"),
      });
      const id = service.saveReport(datasetId, configVersion, flags.kind ?? "fit", flags.name, result);
      console.log(toJSON({ reportId: id, name: flags.name }));
      break;
    }
    default:
      console.error(`未知命令: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

try {
  main();
} catch (e) {
  if (e instanceof ValidationError) {
    console.error(`输入错误: ${e.message}`);
    process.exitCode = 1;
  } else if (e instanceof FeasibilityError) {
    console.error(`不可行: ${e.message}`);
    process.exitCode = 1;
  } else if (e instanceof BudgetExceededError) {
    console.error(`预算耗尽（未完成，非精确最优）: ${e.message}`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
