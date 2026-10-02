import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { Store } from "./db.js";
import { AnalysisService } from "./service.js";
import { segmentsToCSV, toJSON } from "./exporters.js";
import {
  BudgetExceededError,
  FeasibilityError,
  ValidationError,
} from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

const store = new Store(resolve(DATA_DIR, "changepoint.db"));
const service = new AnalysisService(store);

interface ApiResponse {
  ok: boolean;
  data?: unknown;
  error?: { type: string; message: string };
  disclaimer?: string;
}

const DISCLAIMER =
  "检测到的变点仅是给定加权最小二乘目标下的最优分割点，不构成因果变化声明，也不代表统计显著性。";

function send(res: ServerResponse, status: number, body: ApiResponse) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.trim() === "") return {};
  return JSON.parse(raw);
}

function handleError(res: ServerResponse, e: unknown) {
  if (e instanceof ValidationError) return send(res, 400, { ok: false, error: { type: "validation", message: e.message } });
  if (e instanceof FeasibilityError) return send(res, 422, { ok: false, error: { type: "infeasible", message: e.message } });
  if (e instanceof BudgetExceededError)
    return send(res, 409, {
      ok: false,
      error: { type: "budget_exceeded", message: e.message },
    });
  if (e instanceof SyntaxError) return send(res, 400, { ok: false, error: { type: "bad_json", message: "请求体不是合法 JSON" } });
  const message = e instanceof Error ? e.message : String(e);
  return send(res, 500, { ok: false, error: { type: "internal", message } });
}

async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && path === "/health") {
      return send(res, 200, { ok: true, data: { status: "up", dataDir: DATA_DIR } });
    }

    if (method === "POST" && path === "/api/datasets") {
      const body = await readJson(req);
      const created = service.importDataset(body.name ?? "dataset", body.rows ?? [], {
        weights: body.weights,
        minSegmentLength: body.minSegmentLength,
        penalty: body.penalty,
      });
      return send(res, 201, { ok: true, data: created });
    }

    if (method === "GET" && path === "/api/datasets") {
      return send(res, 200, { ok: true, data: service.listDatasets() });
    }

    let m = path.match(/^\/api\/datasets\/(\d+)\/configs$/);
    if (method === "POST" && m) {
      const datasetId = Number(m[1]);
      const body = await readJson(req);
      const version = service.addConfigVersion(datasetId, body);
      return send(res, 201, { ok: true, data: { datasetId, configVersion: version } });
    }

    m = path.match(/^\/api\/datasets\/(\d+)\/fit$/);
    if (method === "POST" && m) {
      const datasetId = Number(m[1]);
      const body = await readJson(req);
      const result =
        body.k !== undefined
          ? service.fitFixedK(datasetId, body.k, {
              configVersion: body.configVersion,
              budget: body.budget,
            })
          : service.fitPenalty(datasetId, {
              configVersion: body.configVersion,
              penalty: body.penalty,
              budget: body.budget,
            });
      return send(res, 200, {
        ok: true,
        data: result,
        disclaimer: result.complete ? DISCLAIMER : undefined,
      });
    }

    m = path.match(/^\/api\/datasets\/(\d+)\/scan$/);
    if (method === "POST" && m) {
      const datasetId = Number(m[1]);
      const body = await readJson(req);
      const result = service.scanPenalties(datasetId, body.penalties ?? [], {
        configVersion: body.configVersion,
        budget: body.budget,
      });
      return send(res, 200, { ok: true, data: result, disclaimer: DISCLAIMER });
    }

    m = path.match(/^\/api\/datasets\/(\d+)\/verify$/);
    if (method === "POST" && m) {
      const datasetId = Number(m[1]);
      const body = await readJson(req);
      const result = service.verifyExternal(datasetId, body.cuts ?? [], {
        configVersion: body.configVersion,
        reportedUnpenalizedCost: body.reportedUnpenalizedCost,
      });
      return send(res, 200, { ok: true, data: result });
    }

    m = path.match(/^\/api\/datasets\/(\d+)\/compare$/);
    if (method === "POST" && m) {
      const datasetId = Number(m[1]);
      const body = await readJson(req);
      const result = service.compareVersions(datasetId, body.versionA, body.versionB, {
        budget: body.budget,
      });
      return send(res, 200, { ok: true, data: result, disclaimer: DISCLAIMER });
    }

    m = path.match(/^\/api\/datasets\/(\d+)\/export$/);
    if (method === "POST" && m) {
      const datasetId = Number(m[1]);
      const body = await readJson(req);
      const result =
        body.k !== undefined
          ? service.fitFixedK(datasetId, body.k, {
              configVersion: body.configVersion,
              budget: body.budget,
            })
          : service.fitPenalty(datasetId, {
              configVersion: body.configVersion,
              penalty: body.penalty,
              budget: body.budget,
            });
      if (body.format === "csv") {
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="segments.csv"',
        });
        return res.end(segmentsToCSV(result));
      }
      return send(res, 200, { ok: true, data: JSON.parse(toJSON(result)) });
    }

    m = path.match(/^\/api\/datasets\/(\d+)\/reports$/);
    if (method === "POST" && m) {
      const datasetId = Number(m[1]);
      const body = await readJson(req);
      const id = service.saveReport(
        datasetId,
        body.configVersion,
        body.kind ?? "custom",
        body.name,
        body.payload,
      );
      return send(res, 201, { ok: true, data: { reportId: id, name: body.name } });
    }

    if (method === "GET" && path === "/api/reports") {
      return send(res, 200, { ok: true, data: store.listReports() });
    }

    return send(res, 404, { ok: false, error: { type: "not_found", message: `未知路由 ${method} ${path}` } });
  } catch (e) {
    return handleError(res, e);
  }
}

const server = createServer(handler);
server.listen(PORT, () => {
  console.log(`[changepoint] HTTP API 已启动: http://localhost:${PORT}`);
  console.log(`[changepoint] 数据目录: ${DATA_DIR}`);
});

export { store, service };
