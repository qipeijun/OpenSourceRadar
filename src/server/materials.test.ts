import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import type { Fetch } from './http.js';
import type { ProjectBrief } from '../shared/contracts.js';

it('生成双平台文案，定向修改保留人工编辑，恢复旧版并只导出所选正文', async () => {
  let requested = 0;
  const fetcher = (async (_url, init) => {
    requested++;
    const body = JSON.parse(String(init?.body));
    expect(body.store).toBe(false);
    expect(String(init?.body)).not.toContain('内部经营备注不可公开');
    expect(body.input[1].content).toContain('公开使用指导');
    const value = { titles: [`标题${requested}`, '标题备选二', '标题备选三'], body: `短正文${requested}，介绍真实用途。需要配置协助可先说明场景。`, evidenceIds: ['e1'] };
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
  }) as Fetch;
  const { app, store } = createApp({ config: loadConfig({ RADAR_DATABASE_PATH: ':memory:', GPT_API_KEY: 'private-key' }), fetch: fetcher });
  store.upsertProject({ id: 1, fullName: 'example/tool', url: 'https://github.com/example/tool', description: '', language: null, stars: 100, dailyStars: null, sourceUrl: 'https://github.com/trending', lastSeenAt: '2026-10-30T00:00:00Z' });
  store.addEvidence({ id: 'e1', projectId: 1, source: 'repository', title: 'README', url: 'https://github.com/example/tool', excerpt: '功能材料', collectedAt: '2026-10-30T00:00:00Z', query: null, coverage: 'full', limitation: '作者声明' });
  const item = { text: '事实用途', certainty: 'fact' as const, evidenceIds: ['e1'] };
  store.addBrief({ id: 'brief', projectId: 1, createdAt: '2026-10-30T00:00:00Z', purpose: [item], environment: [item], dependencies: [item], limitations: [item], pendingChecks: ['待核验'], provider: 'test', model: 'test', configVersion: 'v1', usage: null, inputSnapshot: null } as ProjectBrief);
  const post = async (payload: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url: '/api/projects/1/materials', payload });
    expect(response.statusCode).toBe(201); return response.json();
  };
  try {
    expect((await app.inject({ method: 'PUT', url: '/api/service-profile', payload: { public: { guidance: '公开使用指导' }, internalNote: '内部经营备注不可公开' } })).statusCode).toBe(200);
    const first = await post({ action: 'generate', platform: 'xiaohongshu' });
    const other = await post({ action: 'generate', platform: 'xianyu' });
    expect(other.platform).toBe('xianyu');
    const manual = await post({ action: 'manual', baseVersionId: first.id, titles: ['人工标题'], body: '人工编辑正文，请保留' });
    const revised = await post({ action: 'revise', baseVersionId: manual.id, scope: 'titles', instruction: '标题再短一点' });
    expect(revised.body).toBe('人工编辑正文，请保留');
    expect(revised.titles[0]).toBe('标题3');
    const restored = await post({ action: 'restore', baseVersionId: revised.id, restoreVersionId: first.id });
    expect(restored.id).not.toBe(first.id); expect(restored.restoredFromId).toBe(first.id); expect(restored.body).toBe(first.body);
    expect(store.materials(1)).toHaveLength(5);
    const wrongPlatform = await app.inject({ method: 'POST', url: '/api/projects/1/materials', payload: { action: 'restore', baseVersionId: revised.id, restoreVersionId: other.id } });
    expect(wrongPlatform.statusCode).toBe(404);
    const exported = await app.inject(`/api/projects/1/materials/${manual.id}/text`);
    expect(exported.body).toBe('人工标题\n\n人工编辑正文，请保留\n');
    expect(exported.body).not.toMatch(/private-key|内部经营备注|inputSnapshot|公开使用指导/);
    expect(requested).toBe(3);
  } finally { await app.close(); }
});

it('独立切换检索服务不会改变分析服务选择', async () => {
  const { app } = createApp({ config: loadConfig({ RADAR_DATABASE_PATH: ':memory:', GPT_API_KEY: 'gpt', AI_API_KEY: 'backup', SEARCH_API_KEY: 'search', SEARCH_MODEL: 'search-model' }) });
  try {
    await app.inject({ method: 'PUT', url: '/api/settings/analysis', payload: { provider: 'deepseek' } });
    expect((await app.inject({ method: 'PUT', url: '/api/settings/search', payload: { provider: 'gpt' } })).statusCode).toBe(200);
    const settings = (await app.inject('/api/settings')).json();
    expect(settings.analysisProvider).toBe('deepseek');
    expect(settings.search.provider).toBe('gpt');
    await app.inject({ method: 'PUT', url: '/api/settings/search', payload: { provider: 'configured' } });
    expect((await app.inject('/api/status')).json().searchModel).toBe('search-model');
    expect((await app.inject('/api/settings')).json().analysisProvider).toBe('deepseek');
  } finally { await app.close(); }
});
