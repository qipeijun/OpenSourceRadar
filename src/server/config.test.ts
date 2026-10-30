import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isConfigured, loadConfig } from './config.js';
import { createApp } from './app.js';

describe('本地配置', () => {
  it.each([
    ['.env.example', 'https://api.openai.com/v1', 'gpt-4.1-mini', 'gpt-4.1-mini'],
    ['.env.deepseek.example', 'https://api.deepseek.com', 'deepseek-flash', 'deepseek-v4-pro'],
  ])('使用 %s 只填一个 key 即可配置两项服务，状态接口不返回密钥', async (template, baseUrl, analysisModel, searchModel) => {
    const env = parseEnv(readFileSync(new URL(`../../${template}`, import.meta.url), 'utf8'));
    const config = loadConfig({ ...env, AI_API_KEY: 'local-test-secret', RADAR_DATABASE_PATH: ':memory:' });
    expect(isConfigured(config.analysis)).toBe(true);
    expect(isConfigured(config.search)).toBe(true);
    expect(config.search.apiKey).toBe('local-test-secret');
    expect(config.analysis).toMatchObject({ baseUrl, model: analysisModel });
    expect(config.search).toMatchObject({ baseUrl, model: searchModel });
    expect(loadConfig({ ...env, AI_API_KEY: 'analysis-key', SEARCH_API_KEY: 'search-key' }).search.apiKey).toBe('search-key');
    const { app } = createApp({ config });
    try {
      const response = await app.inject('/api/status');
      expect(response.json()).toMatchObject({ analysisConfigured: true, searchConfigured: true });
      expect(response.body).not.toContain('local-test-secret');
    } finally { await app.close(); }
  });

  it('默认模型和空白配置可加载，但没有 key 仍为未配置', () => {
    const config = loadConfig({ AI_MODEL: '', SEARCH_MODEL: ' ', AI_API_KEY: ' ', SEARCH_API_KEY: '' });
    expect(config.analysis.model).toBe('gpt-4.1-mini');
    expect(config.search.model).toBe('gpt-4.1-mini');
    expect(isConfigured(config.analysis)).toBe(false);
    expect(isConfigured(config.search)).toBe(false);
  });

  it('独立检索密钥和显式模型优先于默认配置', () => {
    const config = loadConfig({ AI_API_KEY: 'analysis-key', SEARCH_API_KEY: 'search-key', AI_MODEL: 'analysis-model', SEARCH_MODEL: 'search-model' });
    expect(config.analysis.model).toBe('analysis-model');
    expect(config.search).toMatchObject({ apiKey: 'search-key', model: 'search-model' });
  });

  it.each(['AI_BASE_URL', 'SEARCH_BASE_URL'])('修改 %s 后不会跨服务复用密钥或补入 OpenAI 模型', key => {
    const config = loadConfig({ [key]: 'https://other.example/v1', AI_API_KEY: 'analysis-key' });
    expect(config.search.apiKey).toBe('');
    expect(isConfigured(config.search)).toBe(false);
    expect((key === 'AI_BASE_URL' ? config.analysis : config.search).model).toBe('');
  });

  it('两个服务可使用独立地址、模型与密钥', () => {
    const config = loadConfig({ AI_BASE_URL: 'https://analysis.example/v1/', AI_API_KEY: 'analysis-key', AI_MODEL: 'analysis-model', SEARCH_BASE_URL: 'https://search.example/v1/', SEARCH_API_KEY: 'search-key', SEARCH_MODEL: 'search-model' });
    expect(config.analysis).toEqual({ baseUrl: 'https://analysis.example/v1', apiKey: 'analysis-key', model: 'analysis-model' });
    expect(config.search).toEqual({ baseUrl: 'https://search.example/v1', apiKey: 'search-key', model: 'search-model' });
  });

  it.each([
    ['https://api.deepseek.com', 'https://api.openai.com/v1'],
    ['https://api.openai.com/v1', 'https://api.deepseek.com'],
    ['https://custom.example/v1', 'https://custom.example/v1'],
  ])('分析 %s 与检索 %s 不自动共用密钥', (analysisBaseUrl, searchBaseUrl) => {
    const config = loadConfig({ AI_BASE_URL: analysisBaseUrl, SEARCH_BASE_URL: searchBaseUrl, AI_API_KEY: 'private-key', AI_MODEL: 'analysis-model', SEARCH_MODEL: 'search-model' });
    expect(config.search.apiKey).toBe('');
    expect(isConfigured(config.search)).toBe(false);
  });
});

describe('GPT 主服务与凭据隔离', () => {
  it('有 GPT 凭据时优先使用 Responses，保留独立备用和检索凭据', () => {
    const config = loadConfig({ GPT_API_KEY: 'gpt-secret', GPT_BASE_URL: 'https://gateway.example/v1', GPT_ACTOR_AUTHORIZATION: 'actor', AI_BASE_URL: 'https://api.deepseek.com', AI_API_KEY: 'deepseek-secret', AI_MODEL: 'deepseek-flash', SEARCH_API_KEY: 'search-secret' });
    expect(config.analysis).toMatchObject({ apiKey: 'gpt-secret', model: 'gpt-6.1-sol', wire: 'responses', actorAuthorization: 'actor' });
    expect(config.providers?.deepseek.apiKey).toBe('deepseek-secret');
    expect(config.search.apiKey).toBe('search-secret');
    expect(() => loadConfig({ GPT_STORE_RESPONSES: 'true' })).toThrow('存储必须关闭');
  });
  it('切换持久化，不返回密钥，未配置服务不能切换', async () => {
    const config = loadConfig({ RADAR_DATABASE_PATH: ':memory:', GPT_API_KEY: 'gpt-secret', AI_API_KEY: 'backup-secret' });
    const { app } = createApp({ config });
    try {
      expect((await app.inject('/api/settings')).json().analysisProvider).toBe('gpt');
      const result = await app.inject({ method: 'PUT', url: '/api/settings/analysis', payload: { provider: 'deepseek' } });
      expect(result.statusCode).toBe(200);
      expect((await app.inject('/api/settings')).json().analysisProvider).toBe('deepseek');
      expect((await app.inject('/api/settings')).body).not.toMatch(/gpt-secret|backup-secret/);
      expect((await app.inject('/api/status')).body).not.toMatch(/gpt-secret|backup-secret/);
    } finally { await app.close(); }
    const missing = createApp({ config: loadConfig({ RADAR_DATABASE_PATH: ':memory:' }) });
    try { expect((await missing.app.inject({ method: 'PUT', url: '/api/settings/analysis', payload: { provider: 'gpt' } })).statusCode).toBe(422); }
    finally { await missing.app.close(); }
  });
});
