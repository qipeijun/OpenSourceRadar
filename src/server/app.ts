import { registerMaterialRoutes } from './material-routes.js';
import { registerImageRoutes } from './image-routes.js';
import { generateBrief } from './brief.js';
import { OperationGate } from './operation.js';
import Fastify, { type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DecisionInputSchema, ManualEvidenceInputSchema, type StatusResponse } from '../shared/contracts.js';
import { imageConfigured, isConfigured, type Config } from './config.js';
import { Store } from './store.js';
import { RadarService } from './service.js';
import type { Fetch } from './http.js';

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
export function createApp(options: { config: Config; store?: Store; fetch?: Fetch; staticRoot?: string }) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const store = options.store ?? new Store(options.config.databasePath);
  const briefGate = new OperationGate();
  const briefPending = new Set<number>();
  const service = new RadarService(store, options.config, options.fetch);
  app.addHook('onRequest', async (req, reply) => {
    let host: string;
    try { host = new URL(`http://${req.headers.host ?? ''}`).hostname; } catch { return reply.code(403).send({ error: '仅允许本机访问' }); }
    if (!localHosts.has(host)) return reply.code(403).send({ error: '仅允许本机访问' });
    const origin = req.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (!localHosts.has(parsed.hostname) || !['http:', 'https:'].includes(parsed.protocol)) return reply.code(403).send({ error: '拒绝跨站访问本地工作台' });
      } catch { return reply.code(403).send({ error: '来源无效' }); }
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: '拒绝跨站访问本地工作台' });
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: '输入格式不正确，请检查必填字段和链接' });
    const statusCode = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    return reply.code(statusCode >= 400 && statusCode < 500 ? statusCode : 500).send({ error: statusCode < 500 ? '请求格式不正确' : '本地服务处理失败，请检查数据文件与请求条件' });
  });
  app.get('/api/status', async (): Promise<StatusResponse> => {
    const projects = store.projects();
    return { analysisConfigured: isConfigured(service.analysisConfig()), searchConfigured: isConfigured(service.searchConfig()), analysisModel: service.analysisConfig().model || null, searchModel: service.searchConfig().model || null, batchSize: options.config.batchSize, activeRun: service.activeRun(), latestRun: store.runs()[0] ?? null, projectCount: projects.length, analyzedCount: projects.filter(p => p.latestAnalysis).length };
  });
  app.get('/api/settings', async () => ({
    analysisProvider: service.selectedProvider(),
    providers: Object.entries(options.config.providers ?? {}).map(([id, config]) => ({ id, model: config.model, configured: isConfigured(config), protocol: config.wire ?? 'chat' })),
    search: { model: service.searchConfig().model, configured: isConfigured(service.searchConfig()), provider: store.searchProvider() },
    searchProviders: [{ id: 'configured', model: options.config.search.model, configured: isConfigured(options.config.search) }, { id: 'gpt', model: options.config.providers?.gpt.model ?? '', configured: Boolean(options.config.providers && isConfigured(options.config.providers.gpt)) }],
    // 生图独立于分析服务：只有 GPT 网关核验过，因此不随分析切换改变，也不与文本模型混用同一模型名。
    images: {
      configured: imageConfigured(options.config.image), driverModel: options.config.image.model, imageModel: options.config.image.imageModel,
      provider: options.config.image.apiKey ? new URL(options.config.image.baseUrl).hostname : null,
      capability: store.capabilities().image ?? null,
    },
    capabilities: store.capabilities(),
  }));
  app.put('/api/settings/analysis', async (req, reply) => {
    const { provider } = z.object({ provider: z.enum(['gpt', 'deepseek']) }).parse(req.body);
    const config = options.config.providers?.[provider];
    if (!config || !isConfigured(config)) return reply.code(422).send({ error: '所选服务尚未配置，请在服务端填写对应凭据和模型' });
    store.setAnalysisProvider(provider);
    return { provider, model: config.model };
  });
  app.put('/api/settings/search', async (req, reply) => {
    const { provider } = z.object({ provider: z.enum(['configured', 'gpt']) }).parse(req.body);
    const config = provider === 'gpt' ? options.config.providers?.gpt : options.config.search;
    if (!config || !isConfigured(config)) return reply.code(422).send({ error: '该检索服务尚未配置' });
    store.setSearchProvider(provider);
    return { provider, model: config.model };
  });
  app.get('/api/projects', async () => ({ projects: store.projects() }));
  app.get('/api/runs', async () => ({ runs: store.runs() }));
  const idFrom = (params: unknown) => z.object({ id: z.coerce.number().int().positive() }).parse(params).id;
  app.get('/api/projects/:id', async (req, reply) => { const detail = store.detail(idFrom(req.params)); return detail ?? reply.code(404).send({ error: '项目不存在' }); });
  app.get('/api/projects/:id/observations', async (req, reply) => {
    const id = idFrom(req.params);
    if (!store.project(id)) return reply.code(404).send({ error: '项目不存在' });
    return { observations: store.observations(id) };
  });
  app.get('/api/projects/:id/briefs', async (req, reply) => {
    const id = idFrom(req.params);
    if (!store.project(id)) return reply.code(404).send({ error: '项目不存在' });
    return { briefs: store.briefs(id) };
  });
  app.post('/api/projects/:id/briefs', async (req, reply) => {
    const id = idFrom(req.params);
    const project = store.project(id);
    if (!project) return reply.code(404).send({ error: '项目不存在' });
    if (briefPending.has(id)) return reply.code(409).send({ error: '该项目正在生成资料，请等待完成' });
    const config = { ...service.analysisConfig() };
    if (!isConfigured(config)) return reply.code(422).send({ error: '请先配置分析服务' });
    const saved = store.evidence(id);
    const readme = saved.find(item => item.source === 'repository' && item.title.startsWith('README'));
    if (!readme) return reply.code(422).send({ error: '尚未获取 README，请先分析项目以收集官方材料' });
    const metadata = saved.find(item => item.source === 'repository' && item.title === 'GitHub 仓库信息');
    briefPending.add(id);
    try {
      const brief = await briefGate.run(`${config.baseUrl}:${config.model}`, () => generateBrief(options.fetch ?? globalThis.fetch, config, project, [readme, ...(metadata ? [metadata] : []), ...saved.filter(item => item.source === 'manual')]));
      store.addBrief(brief);
      return reply.code(201).send(brief);
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(502).send({ error: '生成资料结构不完整，已有资料保留，请重试' });
      return reply.code(502).send({ error: error instanceof Error ? error.message : '生成资料失败，已有资料保留，请重试' });
    } finally { briefPending.delete(id); }
  });
  app.post('/api/discover', async (_req, reply) => {
    if (service.activeRun()) return reply.code(409).send({ error: '已有任务正在运行，请等待完成' });
    return reply.code(202).send(service.start('discover'));
  });
  const beginAnalysis = (reply: FastifyReply, id: number | null) => {
    if (service.activeRun()) return reply.code(409).send({ error: '已有任务正在运行，请等待完成' });
    if (!isConfigured(service.analysisConfig()) || !isConfigured(service.searchConfig())) return reply.code(422).send({ error: '请在本地 .env 填写 AI_API_KEY 后重启服务；自定义服务还需检查模型与独立的 SEARCH_API_KEY，详见 .env.example' });
    return reply.code(202).send(service.start('analyze', id));
  };
  app.post('/api/analyze', async (_req, reply) => beginAnalysis(reply, null));
  app.post('/api/projects/:id/analyze', async (req, reply) => {
    const id = idFrom(req.params); if (!store.project(id)) return reply.code(404).send({ error: '项目不存在' });
    return beginAnalysis(reply, id);
  });
  app.post('/api/projects/:id/decisions', async (req, reply) => {
    const id = idFrom(req.params); const input = DecisionInputSchema.parse(req.body);
    const detail = store.detail(id); if (!detail) return reply.code(404).send({ error: '项目不存在' });
    if (!detail.analyses.some(a => a.id === input.analysisId)) return reply.code(400).send({ error: '分析版本不属于该项目' });
    return reply.code(201).send(store.addDecision(id, input));
  });
  app.post('/api/projects/:id/evidence', async (req, reply) => {
    const id = idFrom(req.params); const input = ManualEvidenceInputSchema.parse(req.body);
    if (!store.project(id)) return reply.code(404).send({ error: '项目不存在' });
    return reply.code(201).send(store.addEvidence({ ...input, id: randomUUID(), projectId: id, source: 'manual', coverage: 'unverified', query: null, collectedAt: new Date().toISOString(), limitation: '经营者人工提供，未独立核验；未抓取此链接。' }));
  });
  registerMaterialRoutes(app, store, service, options.fetch ?? globalThis.fetch);
  registerImageRoutes(app, store, options.config, options.fetch ?? globalThis.fetch);
  const root = options.staticRoot ?? resolve('dist/client');
  if (existsSync(root)) app.register(fastifyStatic, { root });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: '路径不存在；网页尚未打包时请先执行 npm run build' }));
  app.addHook('onClose', async () => { service.stop(); try { await service.waitForIdle(); } finally { if (!options.store) store.close(); } });
  return { app, service, store };
}
