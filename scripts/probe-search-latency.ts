import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/server/config.js';
import { searchEvidence } from '../src/server/ai.js';
import type { Project } from '../src/shared/contracts.js';

/**
 * 受控诊断：上一轮十项试评的三次检索全部在 120 秒整点超时，需实测网关检索真实耗时，
 * 判断是超时阈值过短还是接口契约不支持。只发一次请求，不重试、不降级、不改用其他凭据。
 */
const config = loadConfig();
const db = new DatabaseSync(config.databasePath, { readOnly: true });
const projects = db.prepare('SELECT body FROM projects').all().map(row => JSON.parse(String(row.body)) as Project);
db.close();
const project = projects.find(item => item.fullName === 'HKUDS/DeepTutor');
if (!project) throw new Error('未找到已发现的真实候选，不用构造项目替代');
const search = config.providers?.gpt;
if (!search?.apiKey || !search.model) throw new Error('GPT 检索未配置');

const timeout = Number(process.env.PROBE_TIMEOUT ?? 300_000);
const startedAt = new Date().toISOString();
const t0 = Date.now();
let result: Record<string, unknown>;
try {
  const value = await searchEvidence(globalThis.fetch, search, project, timeout);
  result = {
    status: 'success', outcome: value.outcome, queries: value.queries, citationCount: value.evidence.length,
    evidence: value.evidence.map(item => ({ title: item.title, url: item.url, coverage: item.coverage })),
    usage: value.usage,
  };
} catch (error) {
  result = { status: 'failed', error: error instanceof Error ? error.message : '未知错误' };
}
const report = {
  at: startedAt, project: project.fullName, timeoutMs: timeout, elapsedMs: Date.now() - t0,
  request: { model: search.model, protocol: 'responses', store: false, tools: [{ type: 'web_search' }], tool_choice: 'required', headers: ['authorization: [已脱敏]', 'x-openai-actor-authorization: [已配置]'] },
  search: result,
};
mkdirSync('docs/development/evidence', { recursive: true });
writeFileSync('docs/development/evidence/search-latency-20261030.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ elapsedMs: report.elapsedMs, ...result }));
