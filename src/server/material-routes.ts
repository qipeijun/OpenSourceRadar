import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MaterialContentSchema, PlatformSchema, PublicServiceSchema, type MaterialVersion } from '../shared/contracts.js';
import { isConfigured } from './config.js';
import type { RadarService } from './service.js';
import type { Store } from './store.js';
import type { Fetch } from './http.js';
import { OperationGate } from './operation.js';
import { generateMaterial } from './materials.js';

// scope：titles 仅改标题，body 仅改正文，all 修改整份文案；其他部分由服务端保留。
const InputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('generate'), platform: PlatformSchema, instruction: z.string().max(4000).default('') }),
  z.object({ action: z.literal('revise'), baseVersionId: z.string(), scope: z.enum(['titles', 'body', 'all']), instruction: z.string().min(1).max(4000) }),
  z.object({ action: z.literal('manual'), baseVersionId: z.string(), titles: MaterialContentSchema.shape.titles, body: MaterialContentSchema.shape.body }),
  z.object({ action: z.literal('restore'), baseVersionId: z.string(), restoreVersionId: z.string() }),
]);

export function registerMaterialRoutes(app: FastifyInstance, store: Store, service: RadarService, fetcher: Fetch) {
  const pending = new Set<number>();
  const gate = new OperationGate();
  app.get('/api/service-profile', async () => store.serviceProfile() ?? { public: PublicServiceSchema.parse({}), internalNote: '' });
  app.put('/api/service-profile', async (req) => {
    const profile = z.object({ public: PublicServiceSchema, internalNote: z.string().max(10000).default('') }).parse(req.body);
    store.setServiceProfile(profile); return profile;
  });
  const projectId = (params: unknown) => z.object({ id: z.coerce.number().int().positive() }).parse(params).id;
  app.get('/api/projects/:id/materials', async (req, reply) => {
    const id = projectId(req.params);
    if (!store.project(id)) return reply.code(404).send({ error: '项目不存在' });
    // 每版已配图数量用于提示“文案更新后配图仍是旧版的”，是否重做由经营者决定。
    const images = store.images(id);
    const imageCounts: Record<string, number> = {};
    for (const version of store.materials(id)) imageCounts[version.id] = new Set(images.filter(item => item.materialVersionId === version.id && item.status === 'succeeded').map(item => item.slot)).size;
    return { versions: store.materials(id), imageCounts };
  });
  app.post('/api/projects/:id/materials', async (req, reply) => {
    const id = projectId(req.params); const input = InputSchema.parse(req.body);
    const project = store.project(id);
    if (!project) return reply.code(404).send({ error: '项目不存在' });
    if (pending.has(id)) return reply.code(409).send({ error: '该项目正在生成素材，请等待完成' });
    const versions = store.materials(id);
    const previous = input.action === 'generate' ? undefined : versions.find(item => item.id === input.baseVersionId);
    if (input.action !== 'generate' && !previous) return reply.code(404).send({ error: '指定素材版本不属于该项目' });
    if (input.action === 'manual' || input.action === 'restore') {
      const restored = input.action === 'restore' ? versions.find(item => item.id === input.restoreVersionId && item.platform === previous!.platform) : undefined;
      if (input.action === 'restore' && !restored) return reply.code(404).send({ error: '待恢复版本不属于当前项目和平台' });
      const version: MaterialVersion = {
        ...(restored ?? previous!), ...(input.action === 'manual' ? { titles: input.titles, body: input.body } : {}),
        id: randomUUID(), createdAt: new Date().toISOString(), parentId: previous!.id,
        kind: input.action === 'manual' ? 'manual' : 'restored', instruction: input.action === 'manual' ? '人工编辑' : '恢复历史版本',
        restoredFromId: restored?.id, provider: null, model: null, usage: null,
        inputSnapshot: { baseVersionId: previous!.id, restoredFromId: restored?.id ?? null },
      };
      return reply.code(201).send(store.addMaterial(version));
    }
    const config = { ...service.analysisConfig() };
    if (!isConfigured(config)) return reply.code(422).send({ error: '请先配置分析服务' });
    const brief = store.briefs(id)[0];
    if (!brief) return reply.code(422).send({ error: '请先生成中文资料，确认项目用途与限制' });
    pending.add(id);
    try {
      const version = await gate.run(`${config.baseUrl}:${config.model}`, () => generateMaterial(fetcher, config, {
        project, brief, evidence: store.evidence(id), platform: input.action === 'generate' ? input.platform : previous!.platform,
        service: store.serviceProfile()?.public ?? PublicServiceSchema.parse({}), instruction: input.instruction,
        previous, scope: input.action === 'revise' ? input.scope : undefined,
      }));
      return reply.code(201).send(store.addMaterial(version));
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(502).send({ error: '文案结构不完整，原有版本保留，请重试' });
      return reply.code(502).send({ error: error instanceof Error ? error.message : '文案生成失败，原有版本保留，请重试' });
    } finally { pending.delete(id); }
  });
  app.get('/api/projects/:id/materials/:versionId/text', async (req, reply) => {
    const { versionId } = z.object({ versionId: z.string() }).parse(req.params);
    const version = store.materials(projectId(req.params)).find(item => item.id === versionId);
    if (!version) return reply.code(404).send({ error: '素材版本不存在' });
    // 对外只包含所选版本标题和正文，不包含输入资料、研究备注或服务配置。
    return reply.type('text/plain; charset=utf-8').header('content-disposition', `attachment; filename="${version.platform}-${version.id}.txt"`).send(`${version.titles[0]}\n\n${version.body}\n`);
  });
}
