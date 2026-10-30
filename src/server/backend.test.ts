import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTrending, screenProject } from './github.js';
import { analyze, parseSearchResponse, validateAnalysis } from './ai.js';
import { Store, type ProjectSeed } from './store.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { selectBatch } from './service.js';
import { dimensionKeys, type Analysis, type AnalysisContent, type Evidence, type Project } from '../shared/contracts.js';
import type { Fetch } from './http.js';

const seed: ProjectSeed = { id: 123, fullName: 'example/tool', url: 'https://github.com/example/tool', description: 'Personal productivity notes', language: 'TypeScript', stars: 100, dailyStars: 10, sourceUrl: 'https://github.com/trending?since=daily', lastSeenAt: '2026-10-30T00:00:00.000Z' };
const evidence: Evidence = { id: 'e1', projectId: 123, source: 'search', title: '中文教程', url: 'https://example.com/guide', excerpt: '公开内容', query: 'example/tool 中文教程', collectedAt: '2026-10-30T00:00:00.000Z', coverage: 'excerpt', limitation: '摘要' };
const card = (evidenceId = 'e1'): AnalysisContent => ({ scene: 'productivity', sceneReason: '个人笔记场景', recommendation: 'verify', summary: '先核验部署门槛', whyNow: '进入日榜，持续增长尚未知', audience: '个人笔记用户，真实需求待验证', contentGap: '仅检索到摘要，完整性未知', deliverable: '可研究中文安装排错教程', nextStep: '核验安装流程', costs: '费用与设备未知', counterEvidence: ['已有中文摘要'], unknowns: ['未实测'], changeConditions: ['完整教程已存在时降低优先级'], dimensions: dimensionKeys.map(key => ({ key, level: 'unknown', reason: '证据不足', evidenceIds: [] })), evidenceIds: [evidenceId] });
const analysis = (): Analysis => ({ ...card(), id: 'a1', projectId: 123, createdAt: '2026-10-30T00:00:00.000Z', provider: 'example.com', model: 'test-model', ruleVersion: 'selection-v1', prediction: '暂不可预测', usage: null });
const trending = '<main><article class="Box-row"><h2><a href="/example/tool">example/tool</a></h2><span>1,234 stars today</span></article></main>';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function config(enabled = false) { return loadConfig({ RADAR_DATABASE_PATH: ':memory:', ...(enabled ? { AI_API_KEY: 'test-secret', AI_MODEL: 'test-model', SEARCH_API_KEY: 'search-secret', SEARCH_MODEL: 'search-model' } : {}) }); }
const searchResponse = { status: 'completed', output: [{ type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'example/tool 中文教程 求助' } }, { type: 'message', content: [{ type: 'output_text', text: '该项目存在中文教程摘要，完整部署待核验。', annotations: [{ type: 'url_citation', title: '教程', url: 'https://example.com/guide', start_index: 0, end_index: 20 }] }] }], usage: { total_tokens: 20 } };

function mockedFetch(options: { failAnalysis?: boolean; badRepository?: boolean } = {}): Fetch {
  return (async (input, init) => {
    const url = String(input);
    if (url.includes('github.com/trending')) return new Response(trending);
    if (url.includes('api.github.com/repos/example/tool/readme')) return json({ encoding: 'base64', sha: 'abc1234', content: Buffer.from('# Tool\nPersonal productivity notes').toString('base64') });
    if (url.includes('api.github.com/repos/example/tool')) return json(options.badRepository ? { full_name: 'example/tool' } : { id: 123, full_name: 'example/tool', description: seed.description, language: 'TypeScript', stargazers_count: 100, archived: false, pushed_at: '2026-10-29T00:00:00Z', license: { spdx_id: 'MIT' } });
    if (url.endsWith('/responses')) return json(searchResponse);
    if (url.endsWith('/chat/completions')) {
      if (options.failAnalysis) return json({ error: { message: 'secret should not leak' } }, 401);
      const body = JSON.parse(String(init?.body));
      const materials = JSON.parse(body.messages[1].content) as { evidence: Evidence[] };
      const cited = materials.evidence.find(item => item.source === 'search')!;
      return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(card(cited.id)) } }], usage: { total_tokens: 50 } });
    }
    throw new Error(`Unexpected request ${url}`);
  }) as Fetch;
}

describe('真实来源解析与初筛', () => {
  it('从仓库链接识别候选，解析日榜增量并去重', () => {
    expect(parseTrending(trending + trending)).toEqual([{ fullName: 'example/tool', dailyStars: 1234 }]);
  });
  it('未知页面不能假装空成功，只有明确空提示才返回空', () => {
    expect(() => parseTrending('<main>rate limited</main>')).toThrow('页面结构未识别');
    expect(parseTrending('<main>No repositories found</main>')).toEqual([]);
    expect(parseTrending(trending.replace('1,234 stars today', 'unknown'))[0]?.dailyStars).toBeNull();
  });
  it('简介初筛保留未知项目，不凭缺失描述排除', () => {
    expect(screenProject('').scene).toBe('unknown');
    expect(screenProject('video creation').scene).toBe('content');
    expect(screenProject('database engine').scene).toBe('other');
  });
});

describe('证据约束', () => {
  it('保存工具实际查询与引用摘要，不将摘要标为全文', () => {
    const store = new Store(':memory:'); const project = store.upsertProject(seed);
    const result = parseSearchResponse(searchResponse, project);
    expect(result.evidence[0]?.query).toBe('example/tool 中文教程 求助');
    expect(result.evidence[0]?.coverage).toBe('excerpt');
    expect(result.evidence[0]?.limitation).toContain('不保证需求与教程'); store.close();
  });
  it('拒绝未实际检索和没有引用的模型回答', () => {
    const project = { ...seed } as Project;
    expect(() => parseSearchResponse({ status: 'completed', output: [] }, project)).toThrow('未实际完成');
    expect(parseSearchResponse({ status: 'completed', output: [searchResponse.output[0]] }, project)).toMatchObject({ evidence: [], outcome: 'no_references', queries: ['example/tool 中文教程 求助'] });
  });
  it('拒绝虚构引用、重复维度与无画像的适配判断', () => {
    expect(validateAnalysis(card(), [evidence]).recommendation).toBe('verify');
    expect(() => validateAnalysis(card('fabricated'), [evidence])).toThrow('不存在');
    const duplicate = card(); duplicate.dimensions[1] = duplicate.dimensions[0]!;
    expect(() => validateAnalysis(duplicate, [evidence])).toThrow('结构不完整');
    const fit = card(); fit.dimensions.find(d => d.key === 'fit')!.level = 'high'; fit.dimensions.find(d => d.key === 'fit')!.evidenceIds = ['e1'];
    expect(() => validateAnalysis(fit, [evidence])).toThrow('能力画像');
  });
});

describe('持久化与批次', () => {
  it('仓库改名仍是同一项目，人工决定绑定分析版本并可跨进程读取', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'radar-test-')), 'db.sqlite');
    const store = new Store(path); store.upsertProject(seed); store.addAnalysis(analysis());
    store.addDecision(123, { analysisId: 'a1', action: 'watch', reason: '先核验需求' });
    store.upsertProject({ ...seed, fullName: 'example/renamed', url: 'https://github.com/example/renamed' }); store.close();
    const reopened = new Store(path);
    expect(reopened.projects()).toHaveLength(1);
    expect(reopened.detail(123)?.project.fullName).toBe('example/renamed');
    expect(reopened.detail(123)?.decisions[0]?.reason).toBe('先核验需求');
    expect(() => reopened.addDecision(123, { analysisId: 'missing', action: 'test', reason: '测试' })).toThrow('不属于'); reopened.close();
  });
  it('批次保留未知项目探索位，已分析和范围外项目不重复自动分析', () => {
    const store = new Store(':memory:'); const base = store.upsertProject(seed);
    const items: Project[] = [{ ...base, id: 1, scene: 'content' }, { ...base, id: 2, scene: 'office' }, { ...base, id: 3, scene: 'unknown' }, { ...base, id: 4, scene: 'other' }, { ...base, id: 5, latestAnalysis: analysis() }];
    expect(selectBatch(items, 2).map(p => p.id)).toEqual([1, 3]); store.close();
  });
  it('按日榜增量与固定ID排批次，不受采集先后时间影响', () => {
    const store = new Store(':memory:'); const base = store.upsertProject(seed);
    const items: Project[] = [{ ...base, id: 3, dailyStars: null, lastSeenAt: '2099-01-01' }, { ...base, id: 2, dailyStars: 500, lastSeenAt: '2026-10-30' }, { ...base, id: 1, dailyStars: 500, lastSeenAt: '2026-10-29' }];
    expect(selectBatch(items, 3).map(p => p.id)).toEqual([1, 2, 3]); store.close();
  });
});

describe('完整路由与失败路径', () => {
  it('无需提供链接即可发现、检索、分析并保存人的决定', async () => {
    const { app, service } = createApp({ config: config(true), fetch: mockedFetch() });
    const started = await app.inject({ method: 'POST', url: '/api/discover', payload: {} }); expect(started.statusCode).toBe(202);
    await service.waitForIdle();
    const detail = (await app.inject('/api/projects/123')).json();
    expect(detail.project.latestAnalysis.summary).toBe('先核验部署门槛');
    expect(detail.evidence.some((e: Evidence) => e.source === 'search')).toBe(true);
    const saved = await app.inject({ method: 'POST', url: '/api/projects/123/decisions', payload: { analysisId: detail.project.latestAnalysis.id, action: 'test', reason: '有部署排错价值，安排实测' } });
    expect(saved.statusCode).toBe(201);
    expect((await app.inject('/api/status')).json().latestRun.status).toBe('succeeded'); await app.close();
  });
  it('未配置AI仍可发现真实候选，但不伪造分析；API不泄漏密钥', async () => {
    const { app, service } = createApp({ config: config(), fetch: mockedFetch() });
    await app.inject({ method: 'POST', url: '/api/discover', payload: {} }); await service.waitForIdle();
    expect((await app.inject('/api/projects')).json().projects[0].latestAnalysis).toBeNull();
    expect((await app.inject({ method: 'POST', url: '/api/analyze', payload: {} })).statusCode).toBe(422);
    const status = (await app.inject('/api/status')).json(); expect(status.analysisConfigured).toBe(false); expect(status.latestRun.stage).toContain('配置'); await app.close();
  });
  it('任务仍在执行时拒绝重复发起', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetcher = (async (input: Parameters<Fetch>[0], init: Parameters<Fetch>[1]) => { await gate; return mockedFetch()(input, init); }) as Fetch;
    const { app, service } = createApp({ config: config(), fetch: fetcher });
    expect((await app.inject({ method: 'POST', url: '/api/discover', payload: {} })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: '/api/discover', payload: {} })).statusCode).toBe(409);
    release(); await service.waitForIdle(); await app.close();
  });
  it('关闭服务中止当前请求，不再调用下一项目且不将未执行项计为完成', async () => {
    const store = new Store(':memory:'); store.upsertProject(seed); store.upsertProject({ ...seed, id: 456, fullName: 'example/second' });
    let entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    let requests = 0;
    const fetcher = (async (_input: Parameters<Fetch>[0], init: Parameters<Fetch>[1]) => {
      requests++; entered();
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
    }) as Fetch;
    const { app, service } = createApp({ config: config(true), store, fetch: fetcher });
    await app.inject({ method: 'POST', url: '/api/analyze', payload: {} }); await began;
    await app.close();
    expect(requests).toBe(1); expect(service.activeRun()).toBeNull();
    expect(store.runs()[0]?.status).toBe('failed'); expect(store.runs()[0]?.completed).toBe(0); expect(store.runs()[0]?.stage).toBe('运行已中断'); store.close();
  });
  it('重新分析失败保留旧版和人工决定，外部响应正文不返回用户', async () => {
    const store = new Store(':memory:'); store.upsertProject(seed); store.addAnalysis(analysis()); store.addDecision(123, { analysisId: 'a1', action: 'watch', reason: '待验证' });
    const { app, service } = createApp({ config: config(true), store, fetch: mockedFetch({ failAnalysis: true }) });
    await app.inject({ method: 'POST', url: '/api/projects/123/analyze', payload: {} }); await service.waitForIdle();
    const detail = (await app.inject('/api/projects/123')).json(); expect(detail.project.latestAnalysis.id).toBe('a1'); expect(detail.decisions[0].reason).toBe('待验证'); expect(detail.project.lastError).toContain('401'); expect(JSON.stringify(detail)).not.toContain('secret should not leak');
    const run = (await app.inject('/api/status')).json().latestRun;
    expect(run.status).toBe('failed'); expect(run.stage).toBe('运行失败，未成功完成任何项目处理');
    expect(run.stage).not.toContain('部分'); await app.close(); store.close();
  });
  it('仓库数据不完整时报错，不保存未知star为零', async () => {
    const { app, service } = createApp({ config: config(), fetch: mockedFetch({ badRepository: true }) });
    await app.inject({ method: 'POST', url: '/api/discover', payload: {} }); await service.waitForIdle();
    expect((await app.inject('/api/projects')).json().projects).toHaveLength(0);
    expect((await app.inject('/api/status')).json().latestRun.status).toBe('failed'); await app.close();
  });
  it('拦截跨站与DNS重绑定Host，拒绝无效人工材料', async () => {
    const { app } = createApp({ config: config() });
    expect((await app.inject({ method: 'POST', url: '/api/discover', headers: { origin: 'https://evil.example' }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/status', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/projects/123/evidence', payload: { title: 'x', url: 'javascript:alert(1)', excerpt: 'x' } })).statusCode).toBe(400); await app.close();
  });
});


describe('GPT Responses 契约', () => {
  it('分析走指定网关，关闭存储并使用独立凭据和附加请求头', async () => {
    const config = loadConfig({ GPT_BASE_URL: 'https://gateway.example/v1', GPT_API_KEY: 'gpt-secret', GPT_ACTOR_AUTHORIZATION: 'actor', AI_API_KEY: 'backup-secret' });
    const fetcher = (async (url, init) => {
      expect(String(url)).toBe('https://gateway.example/v1/responses');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer gpt-secret', 'x-openai-actor-authorization': 'actor' });
      const body = JSON.parse(String(init?.body));
      expect(body.store).toBe(false);
      expect(body.model).toBe('gpt-6.1-sol');
      expect(String(init?.body)).not.toContain('backup-secret');
      return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(card()) }] }], usage: { total_tokens: 10 } });
    }) as Fetch;
    const result = await analyze(fetcher, config.analysis, { ...seed } as Project, [evidence], null);
    expect(result.provider).toBe('gateway.example');
    expect(result.ruleVersion).toBe('gpt-responses-v1');
  });
});


describe('分析审计反例', () => {
  it('无引用检索不被当作缺口证据，仓库材料不能独自支持需求维度', () => {
    const value = card(); value.dimensions.find(d => d.key === 'demand')!.level = 'high';
    value.dimensions.find(d => d.key === 'demand')!.evidenceIds = ['e1'];
    expect(() => validateAnalysis(value, [{ ...evidence, source: 'repository' }])).toThrow('对应公开检索证据');
    const weak = card(); weak.recommendation = 'test';
    expect(() => validateAnalysis(weak, [evidence])).toThrow('同时有需求与内容缺口');
  });
  it('简介范围外关键词不在分析前直接排除候选', () => {
    const store = new Store(':memory:');
    const project = store.upsertProject({ ...seed, description: 'database engine' });
    expect(selectBatch([project], 1)).toHaveLength(1);
    expect(screenProject('kernelized personal assistant').scene).toBe('productivity');
    store.close();
  });
});

describe('运行中服务配置固定', () => {
  it('切换只影响下一次分析，当前任务继续使用 GPT，检索凭据独立', async () => {
    const cfg = loadConfig({ RADAR_DATABASE_PATH: ':memory:', GPT_API_KEY: 'gpt-secret', GPT_BASE_URL: 'https://gateway.example/v1', GPT_ACTOR_AUTHORIZATION: 'actor', AI_API_KEY: 'backup-secret', AI_MODEL: 'backup-model', AI_BASE_URL: 'https://backup.example/v1', SEARCH_API_KEY: 'search-secret', SEARCH_BASE_URL: 'https://search.example/v1', SEARCH_MODEL: 'search-model' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const fetcher = (async (input, init) => {
      const url = String(input); calls.push(url);
      if (url.includes('/readme')) { await gate; return json({ encoding: 'base64', sha: 'abcd', content: Buffer.from('# Tool').toString('base64') }); }
      if (url.includes('search.example')) {
        expect(init?.headers).toMatchObject({ authorization: 'Bearer search-secret' });
        expect(init?.headers).not.toHaveProperty('x-openai-actor-authorization');
        return json(searchResponse);
      }
      const body = JSON.parse(String(init?.body));
      const materials = JSON.parse((body.input ?? body.messages)[1].content);
      const id = materials.evidence.find((e: Evidence) => e.source === 'search').id;
      if (url.includes('gateway.example')) {
        expect(init?.headers).toMatchObject({ authorization: 'Bearer gpt-secret' });
        return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(card(id)) }] }] });
      }
      expect(init?.headers).toMatchObject({ authorization: 'Bearer backup-secret' });
      expect(init?.headers).not.toHaveProperty('x-openai-actor-authorization');
      return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(card(id)) } }] });
    }) as Fetch;
    const { app, store, service } = createApp({ config: cfg, fetch: fetcher });
    store.upsertProject(seed);
    try {
      expect((await app.inject({ method: 'POST', url: '/api/projects/123/analyze' })).statusCode).toBe(202);
      await app.inject({ method: 'PUT', url: '/api/settings/analysis', payload: { provider: 'deepseek' } });
      release(); await service.waitForIdle();
      expect(store.project(123)?.latestAnalysis?.provider).toBe('gateway.example');
      expect(store.project(123)?.latestAnalysis?.inputSnapshot).toBeDefined();
      await app.inject({ method: 'POST', url: '/api/projects/123/analyze' }); await service.waitForIdle();
      expect(store.detail(123)?.analyses).toHaveLength(2);
      expect(store.project(123)?.latestAnalysis?.provider).toBe('backup.example');
      expect(calls).toContain('https://backup.example/v1/chat/completions');
    } finally { release(); await app.close(); }
  });
});
