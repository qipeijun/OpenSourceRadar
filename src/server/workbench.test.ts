import { describe, expect, it } from 'vitest';
import { OperationGate } from './operation.js';
import { cumulativeChange } from './trends.js';
import { Store } from './store.js';
import { validateBrief } from './brief.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import type { Evidence, Observation } from '../shared/contracts.js';
import type { Fetch } from './http.js';

const observation: Observation = { projectId: 1, observedAt: '2026-10-30T00:00:00Z', sourceUrl: 'https://github.com/trending?since=daily', stars: 100, dailyStars: 50 };
const evidence: Evidence = { id: 'readme', projectId: 1, source: 'repository', title: 'README · abc', url: 'https://github.com/example/tool#readme', excerpt: 'Requires Node.js', collectedAt: observation.observedAt, query: null, coverage: 'full', limitation: '作者声明' };
const item = { text: '需要 Node.js', certainty: 'fact', evidenceIds: ['readme'] };
const brief = () => ({ purpose: [{ ...item, text: '用途尚不清楚', certainty: 'unknown', evidenceIds: [] }], environment: [item], dependencies: [item], limitations: [{ text: '尚未实测', certainty: 'unknown', evidenceIds: [] }], pendingChecks: ['核验许可证'] });

describe('外部路径停止规则', () => {
  it('连续失败三次停止同一路径，其他路径可继续；成功重置连续计数', async () => {
    const gate = new OperationGate(); let calls = 0;
    const fail = async () => { calls++; throw new Error('HTTP 503'); };
    for (let i = 0; i < 3; i++) await expect(gate.run('gpt/analysis', fail)).rejects.toThrow('503');
    await expect(gate.run('gpt/analysis', fail)).rejects.toThrow('连续失败三次');
    expect(calls).toBe(3);
    await expect(gate.run('deepseek/analysis', async () => 'ok')).resolves.toBe('ok');
    await expect(gate.run('search', fail)).rejects.toThrow();
    await gate.run('search', async () => 'ok');
    expect(gate.stopped('search')).toBe(false);
  });
});

describe('真实趋势观测', () => {
  it('重复观测不覆盖原始值，缺测不补造', () => {
    const store = new Store(':memory:');
    store.addObservation(observation); store.addObservation({ ...observation, stars: 999 });
    store.addObservation({ ...observation, observedAt: '2026-11-02T00:00:00Z', stars: 130, dailyStars: null });
    const rows = store.observations(1);
    expect(rows).toHaveLength(2); expect(rows[0]?.stars).toBe(100);
    expect(cumulativeChange(rows[0]!, rows[1]!)).toEqual({ starsChange: 30, elapsedHours: 72, hasGap: true });
    expect(rows[1]?.dailyStars).toBeNull(); store.close();
  });
  it('不同来源、项目或时间无效不混算，累计下降原样保留', () => {
    expect(cumulativeChange(observation, { ...observation, sourceUrl: 'https://other.example', observedAt: '2026-10-31T00:00:00Z' })).toBeNull();
    expect(cumulativeChange(observation, observation)).toBeNull();
    expect(cumulativeChange(observation, { ...observation, observedAt: '2026-10-31T00:00:00Z', stars: 90 })?.starsChange).toBe(-10);
  });
});

describe('内部资料证据与保存', () => {
  it('拒绝没有来源的确定要求，未知要求保持未知', () => {
    expect(validateBrief(brief(), [evidence]).purpose[0]?.certainty).toBe('unknown');
    const raw = brief(); raw.environment = [{ ...item, evidenceIds: [] }];
    expect(() => validateBrief(raw, [evidence])).toThrow('关联输入来源');
    expect(() => validateBrief(brief(), [])).toThrow('不存在');
  });
  it('真实生成接口保存版本与输入快照，失败保留旧结果', async () => {
    let fail = false;
    const fetcher = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)); expect(body.store).toBe(false);
      expect(body.input[1].content).toContain('Requires Node.js');
      return new Response(JSON.stringify(fail ? { error: 'private upstream error' } : { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(brief()) }] }], usage: { total_tokens: 10 } }), { status: fail ? 401 : 200 });
    }) as Fetch;
    const { app, store } = createApp({ config: loadConfig({ RADAR_DATABASE_PATH: ':memory:', GPT_API_KEY: 'private-key' }), fetch: fetcher });
    store.upsertProject({ id: 1, fullName: 'example/tool', url: 'https://github.com/example/tool', description: '', language: null, stars: 100, dailyStars: null, sourceUrl: observation.sourceUrl, lastSeenAt: observation.observedAt });
    store.addEvidence(evidence);
    try {
      const result = await app.inject({ method: 'POST', url: '/api/projects/1/briefs' });
      expect(result.statusCode).toBe(201); expect(result.json().inputSnapshot.messages).toHaveLength(2);
      expect(result.body).not.toContain('private-key');
      fail = true;
      const failure = await app.inject({ method: 'POST', url: '/api/projects/1/briefs' });
      expect(failure.statusCode).toBe(502); expect(failure.body).not.toContain('private upstream error');
      expect((await app.inject('/api/projects/1/briefs')).json().briefs).toHaveLength(1);
      expect((await app.inject('/api/projects/1/observations')).json().observations).toHaveLength(1);
    } finally { await app.close(); }
  });
});

it('真实批次在检索连续失败三次后停止付费路径，不继续尝试剩余候选', async () => {
  let searches = 0;
  const fetcher = (async (url) => {
    if (String(url).includes('/readme')) return new Response(JSON.stringify({ encoding: 'base64', sha: 'abc', content: Buffer.from('# Project').toString('base64') }));
    searches++;
    return new Response('{}', { status: 503 });
  }) as Fetch;
  const { app, service, store } = createApp({ config: loadConfig({ RADAR_DATABASE_PATH: ':memory:', AI_API_KEY: 'analysis', SEARCH_API_KEY: 'search' }), fetch: fetcher });
  for (let i = 1; i <= 5; i++) store.upsertProject({ id: i, fullName: `example/tool${i}`, url: `https://github.com/example/tool${i}`, description: 'personal productivity', language: null, stars: 100, dailyStars: i, sourceUrl: observation.sourceUrl, lastSeenAt: observation.observedAt });
  try {
    service.start('analyze'); await service.waitForIdle();
    expect(searches).toBe(3);
    expect(store.runs()[0]?.errors.join(' ')).toContain('停止剩余分析');
    expect(store.runs()[0]?.status).toBe('failed');
    service.start('analyze'); await service.waitForIdle();
    expect(searches).toBe(3);
  } finally { await app.close(); }
});


it('鉴权失败即停止该路径，先核对契约而不重复盲试', async () => {
  const gate = new OperationGate(); let calls = 0;
  const fail = async () => { calls++; throw new Error('外部服务返回 HTTP 401'); };
  await expect(gate.run('auth', fail)).rejects.toThrow('401');
  await expect(gate.run('auth', fail)).rejects.toThrow('鉴权失败');
  expect(calls).toBe(1);
});
