import http from 'node:http';
import path from 'node:path';
import { Service } from './service.js';
import { Store } from './store.js';

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
const port = Number(process.env.PORT ?? 3210);
const service = new Service(new Store(dataDir));

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res: http.ServerResponse, code: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const body = req.method === 'POST' ? await readBody(req) : {};

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/datasets') {
      return send(res, 200, service.store.listDatasets());
    }
    if (req.method === 'POST' && url.pathname === '/datasets') {
      return send(res, 200, service.importDataset(body.name ?? null, body.samples, body.config));
    }
    if (parts[0] === 'datasets' && parts[2] === 'import' && req.method === 'POST') {
      return send(res, 200, service.importDataset(null, body.samples, body.config, Number(parts[1])));
    }
    if (parts[0] === 'datasets' && parts[2] === 'versions' && req.method === 'GET') {
      return send(res, 200, service.store.listVersions(Number(parts[1])));
    }
    if (parts[0] === 'datasets' && parts[2] === 'fit' && req.method === 'POST') {
      return send(res, 200, service.fit({ datasetId: Number(parts[1]), ...body }));
    }
    if (parts[0] === 'datasets' && parts[2] === 'scan' && req.method === 'POST') {
      return send(res, 200, service.scan({ datasetId: Number(parts[1]), ...body }));
    }
    if (parts[0] === 'datasets' && parts[2] === 'verify' && req.method === 'POST') {
      return send(res, 200, service.verify({ datasetId: Number(parts[1]), ...body }));
    }
    if (parts[0] === 'versions' && parts[2] === 'samples' && req.method === 'GET') {
      return send(res, 200, service.store.getSamples(Number(parts[1])));
    }
    if (url.pathname === '/versions/compare' && req.method === 'GET') {
      return send(res, 200, service.compareVersions(Number(url.searchParams.get('a')), Number(url.searchParams.get('b'))));
    }
    if (parts[0] === 'reports' && parts.length === 1 && req.method === 'GET') {
      return send(res, 200, service.store.listReports());
    }
    if (parts[0] === 'reports' && parts.length === 2 && req.method === 'GET') {
      const report = service.store.getReport(Number(parts[1]));
      if (!report) return send(res, 404, { error: '报告不存在' });
      return send(res, 200, report);
    }
    if (parts[0] === 'reports' && parts[2] === 'export' && req.method === 'GET') {
      const format = (url.searchParams.get('format') ?? 'json') as 'json' | 'csv';
      const out = service.exportReport(Number(parts[1]), format);
      res.writeHead(200, {
        'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      });
      return res.end(out);
    }
    return send(res, 404, { error: `未知路由 ${req.method} ${url.pathname}` });
  } catch (err) {
    return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, () => {
  console.log(`cpsegment API 已启动: http://localhost:${port} (数据目录: ${dataDir})`);
});
