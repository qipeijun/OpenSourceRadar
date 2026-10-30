import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/server/config.js';
import { searchEvidence } from '../src/server/ai.js';
import { getReadme } from '../src/server/github.js';
import { generateBrief } from '../src/server/brief.js';
import { Store } from '../src/server/store.js';
import type { Project } from '../src/shared/contracts.js';

// 单次受限验收：从现有自动发现候选选取教育工具，不接收任意远端地址或凭据。
const config = loadConfig();
const db = new DatabaseSync(config.databasePath, { readOnly: true });
const active = db.prepare('SELECT body FROM runs').all().some(row => ['running', 'queued'].includes(JSON.parse(String(row.body)).status));
const projects = db.prepare('SELECT body FROM projects').all().map(row => JSON.parse(String(row.body)) as Project);
db.close();
if (active) throw new Error('当前数据库存在执行中任务，本次验收停止，避免干扰');
const project = projects.find(project => project.fullName === 'HKUDS/DeepTutor');
if (!project) throw new Error('未找到指定的已发现真实候选，不构造项目替代');
const report: Record<string, unknown> = { at: new Date().toISOString(), project: project.fullName, searchModel: config.search.model, analysisModel: config.analysis.model };
try {
  const result = await searchEvidence(globalThis.fetch, config.search, project);
  report.search = { status: 'success', outcome: result.outcome, usage: result.usage, queries: result.queries, citationCount: result.evidence.length };
} catch (error) { report.search = { status: 'failed', error: error instanceof Error ? error.message : '未知错误' }; }
try {
  const readme = await getReadme(globalThis.fetch, project.id, project.fullName, config.githubToken);
  const result = await generateBrief(globalThis.fetch, config.analysis, project, [readme]);
  const store = new Store(config.databasePath);
  try { store.addEvidence(readme); store.addBrief(result); } finally { store.close(); }
  report.brief = { status: 'success', id: result.id, usage: result.usage, provider: result.provider, model: result.model, sections: { purpose: result.purpose.length, environment: result.environment.length, dependencies: result.dependencies.length, limitations: result.limitations.length } };
} catch (error) { report.brief = { status: 'failed', error: error instanceof Error ? error.message : '未知错误' }; }
mkdirSync('docs/development/evidence', { recursive: true });
writeFileSync('docs/development/evidence/workbench-verification-20261030.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
