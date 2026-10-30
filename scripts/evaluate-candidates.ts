import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/server/config.js';
import { Store } from '../src/server/store.js';
import { RadarService } from '../src/server/service.js';

// 本轮任务书限定的十项真实候选试评，无自动重试或自动降级。
const config = loadConfig(); config.batchSize = 10;
const check = new DatabaseSync(config.databasePath, { readOnly: true });
const active = check.prepare('SELECT body FROM runs').all().some(row => ['running', 'queued'].includes(JSON.parse(String(row.body)).status));
check.close();
if (active) throw new Error('已有运行中任务，停止启动试评');
const store = new Store(config.databasePath);
store.setAnalysisProvider('gpt');
store.setSearchProvider('gpt');
const service = new RadarService(store, config);
const stop = () => service.stop();
process.once('SIGTERM', stop); process.once('SIGINT', stop);
const run = service.start('analyze');
console.log(JSON.stringify({ runId: run.id, analysis: service.analysisConfig().model, search: service.searchConfig().model, limit: config.batchSize }));
const timer = setInterval(() => { const active = service.activeRun(); if (active) console.log(JSON.stringify({ stage: active.stage, completed: active.completed, total: active.total, errors: active.errors })); }, 15_000);
try {
  await service.waitForIdle();
  const result = store.runs().find(item => item.id === run.id);
  const projects = store.projects().filter(item => item.latestAnalysis && item.latestAnalysis.createdAt >= run.startedAt).map(item => ({ id: item.id, fullName: item.fullName, analysisId: item.latestAnalysis!.id, recommendation: item.latestAnalysis!.recommendation, summary: item.latestAnalysis!.summary, usage: item.latestAnalysis!.usage }));
  mkdirSync('docs/development/evidence', { recursive: true });
  writeFileSync('docs/development/evidence/candidate-evaluation-20261030.json', JSON.stringify({ run: result, projects }, null, 2) + '\n');
  console.log(JSON.stringify({ run: result, analyses: projects.length }));
} finally { clearInterval(timer); service.stop(); store.close(); }
