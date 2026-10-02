import fs from 'node:fs';
import path from 'node:path';
import { Service } from './service.js';
import { Store } from './store.js';
import type { Sample } from './types.js';

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
const service = new Service(new Store(dataDir));

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      opts[argv[i].slice(2)] = argv[i + 1] ?? '';
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, opts };
}

function readSamplesFile(file: string): Sample[] {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : data.samples;
  }
  // CSV：首行表头 t,v0,v1,...
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(',').map(Number);
    return { t: cols[0], values: cols.slice(1, header.length) };
  });
}

function print(x: unknown) {
  console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, opts } = parseArgs(rest);
  switch (cmd) {
    case 'import': {
      const samples = readSamplesFile(positional[0]);
      const weights = opts.weights.split(',').map(Number);
      const minSegmentLength = Number(opts['min-len'] ?? 1);
      const datasetId = opts.dataset ? Number(opts.dataset) : undefined;
      print(
        service.importDataset(opts.name ?? null, samples, { weights, minSegmentLength }, datasetId),
      );
      break;
    }
    case 'fit': {
      const datasetId = Number(opts.dataset);
      const budget = opts['max-cells'] || opts['max-transitions']
        ? {
            maxCostCells: opts['max-cells'] ? Number(opts['max-cells']) : undefined,
            maxDpTransitions: opts['max-transitions'] ? Number(opts['max-transitions']) : undefined,
          }
        : undefined;
      if (opts.segments !== undefined) {
        print(service.fit({ datasetId, segments: Number(opts.segments), budget }));
      } else {
        print(service.fit({ datasetId, penalty: Number(opts.penalty ?? 0), budget }));
      }
      break;
    }
    case 'scan': {
      print(
        service.scan({
          datasetId: Number(opts.dataset),
          penalties: opts.penalties.split(',').map(Number),
        }),
      );
      break;
    }
    case 'verify': {
      print(
        service.verify({
          datasetId: Number(opts.dataset),
          changepoints: opts.boundaries.split(',').filter(Boolean).map(Number),
          penalty: opts.penalty !== undefined ? Number(opts.penalty) : null,
        }),
      );
      break;
    }
    case 'compare': {
      print(service.compareVersions(Number(opts.a), Number(opts.b)));
      break;
    }
    case 'export': {
      const out = service.exportReport(Number(opts.report), (opts.format ?? 'json') as 'json' | 'csv');
      if (opts.out) fs.writeFileSync(opts.out, out);
      else print(out);
      break;
    }
    case 'list': {
      print(service.store.listDatasets());
      break;
    }
    case 'reports': {
      print(service.store.listReports(opts.version ? Number(opts.version) : undefined));
      break;
    }
    default:
      console.log(`用法: node dist/src/cli.js <命令> [选项]
  import <file.json|csv> --name N --weights 1,1 --min-len 3 [--dataset ID]
  fit --dataset ID [--penalty P | --segments K] [--max-cells N] [--max-transitions N]
  scan --dataset ID --penalties 0,1,10,100
  verify --dataset ID --boundaries 10,20 [--penalty P]
  compare --a VERSION_ID --b VERSION_ID
  export --report ID --format json|csv [--out FILE]
  list | reports [--version ID]
启动 API 服务: npm start (PORT 环境变量可配置端口，默认 3210)`);
  }
}

main()
  .catch((err) => {
    console.error('错误:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => service.store.close());
