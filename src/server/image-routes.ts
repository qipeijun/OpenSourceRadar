import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { platformNames, VisualStyleSchema, type MaterialImage, type MaterialVersion } from '../shared/contracts.js';
import { imageConfigured, type Config } from './config.js';
import type { Store } from './store.js';
import type { Fetch } from './http.js';
import { OperationGate } from './operation.js';
import {
  briefLimitations, briefPurposes, composePrompt, generateImage, imageSlots, imageStorageRoot, mimeFormatOf,
  ReferenceInputSchema, referenceFile, resolveImageFile, saveGeneratedImage, saveReferenceImage,
} from './images.js';
import { createZip, safeZipName } from './zip.js';

// slot 由服务端按三张配图的固定用途推进：整套生成每次只做一张，失败不影响已成功的那张。
const GenerateSchema = z.object({ action: z.literal('generate'), materialVersionId: z.string().min(1), instruction: z.string().max(4000).default(''), references: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)).max(4).default([]) });
// 修改这一张：目标图片由 URL 指定，以其历史记录为父版本新建一张，不覆盖旧图。
const ReviseSchema = z.object({ action: z.literal('revise'), instruction: z.string().min(1).max(4000), references: z.array(z.string().regex(/^[A-Za-z0-9._-]+$/)).max(4).default([]) });
const RestoreSchema = z.object({ action: z.literal('restore'), restoreImageId: z.string().min(1) });
const ImageActionSchema = z.discriminatedUnion('action', [ReviseSchema, RestoreSchema]);

export function registerImageRoutes(app: FastifyInstance, store: Store, config: Config, fetcher: Fetch) {
  const root = imageStorageRoot(config.databasePath);
  const gate = new OperationGate();
  const pending = new Set<number>();
  const imageService = config.image;

  const imagesOf = (projectId: number) => store.images(projectId);

  app.get('/api/settings/visual-style', async (req) => {
    const query = z.object({ projectId: z.coerce.number().int().positive().optional() }).parse(req.query);
    // 项目级未单独调整时展示继承来的全局风格，并标记为“沿用全局”，避免误认为已保存项目副本。
    const override = query.projectId === undefined ? store.visualStyle() : store.visualStyle(query.projectId);
    const style = override ?? store.visualStyle() ?? { name: '', direction: '', avoid: '' };
    return { projectId: query.projectId ?? null, style, inherited: query.projectId !== undefined && !override };
  });
  app.put('/api/settings/visual-style', async (req, reply) => {
    const input = z.object({ style: VisualStyleSchema, projectId: z.coerce.number().int().positive().nullable().default(null) }).parse(req.body);
    if (input.projectId !== null && !store.project(input.projectId)) return reply.code(404).send({ error: '项目不存在' });
    store.setVisualStyle(input.style, input.projectId ?? undefined);
    return input;
  });

  app.get('/api/references', async () => ({ references: store.referenceImages() }));
  // 参考图只按已登记记录的 fileName 提供，未登记的名称一律 404，避免读取任意本地文件。
  app.get('/api/references/:fileName', async (req, reply) => {
    const { fileName } = z.object({ fileName: z.string().regex(/^[A-Za-z0-9._-]+\.(png|jpg|webp)$/) }).parse(req.params);
    const known = store.referenceImages().find(item => item.fileName === fileName);
    if (!known) return reply.code(404).send({ error: '参考图不存在' });
    return reply.type(`image/${mimeFormatOf(fileName)}`).send(readFileSync(referenceFile(root, fileName)));
  });
  app.post('/api/references', { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const input = ReferenceInputSchema.parse(req.body);
    try {
      const saved = saveReferenceImage(root, input);
      store.addReferenceImage(saved);
      return reply.code(201).send(saved);
    } catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : '参考图未保存' }); }
  });

  app.get('/api/projects/:id/images', async (req, reply) => {
    const id = projectId(req.params);
    if (!store.project(id)) return reply.code(404).send({ error: '项目不存在' });
    const versions = store.materials(id);
    return { images: imagesOf(id), slots: imageSlots, versions: versions.map(item => ({ id: item.id, platform: item.platform, createdAt: item.createdAt, kind: item.kind })) };
  });

  app.post('/api/projects/:id/images', async (req, reply) => {
    const id = projectId(req.params);
    const input = GenerateSchema.parse(req.body);
    const project = store.project(id);
    if (!project) return reply.code(404).send({ error: '项目不存在' });
    if (!imageConfigured(imageService)) return reply.code(422).send({ error: '生图服务未配置：请在服务端 .env 填写 GPT 网关凭据与 GPT_IMAGE_MODEL' });
    if (pending.has(id)) return reply.code(409).send({ error: '该项目正在生成配图，请等待当前这张完成' });
    const version = store.materials(id).find(item => item.id === input.materialVersionId);
    if (!version || version.projectId !== id) return reply.code(404).send({ error: '所选文案版本不属于该项目' });
    const list = imagesOf(id);
    const index = nextOpenSlot(version.id, list);
    if (index === -1) return reply.code(409).send({ error: '这套配图已经完成，如需调整请使用“修改这一张”' });
    const slot = imageSlots[index]!;
    const brief = store.briefs(id)[0];
    if (!brief) return reply.code(422).send({ error: '请先生成中文资料，确认项目用途与限制后再配图' });
    const previousInSlot = latestForSlot(version.id, slot.slot, list);

    pending.add(id);
    const style = store.effectiveVisualStyle(id);
    const prompt = composePrompt({
      platform: version.platform, projectUrl: project.url, purposes: briefPurposes(brief), limitations: briefLimitations(brief),
      titles: version.titles, body: version.body, slot, style, instruction: input.instruction,
    });
    const base = { projectId: id, platform: version.platform, materialVersionId: version.id, slot: slot.slot, prompt, instruction: input.instruction, provider: new URL(imageService.baseUrl).hostname, model: imageService.imageModel, inputSnapshot: { prompt, materialVersionId: version.id, style, references: input.references, textModel: imageService.model, configVersion: imageService.revision } };
    const remaining = () => currentSet(version.id, imagesOf(id)).filter(item => !item).length;
    const references = input.references.map(name => referenceFile(root, name));
    try {
      const image = await gate.run(`image:${imageService.baseUrl}:${imageService.imageModel}`, async () => {
        const generated = await generateImage(fetcher, imageService, prompt, references);
        const imageId = randomUUID();
        const fileName = saveGeneratedImage(root, id, generated, imageId);
        return { ...base, id: imageId, fileName, width: generated.width, height: generated.height, format: generated.format, usage: { response: generated.usage, revisedPrompt: generated.revisedPrompt } };
      });
      const saved = store.addImage({ ...image, createdAt: new Date().toISOString(), status: 'succeeded', kind: 'generated', parentId: previousInSlot?.id ?? null, restoredFromId: null, error: null });
      store.recordCapability('image', { status: 'succeeded', at: saved.createdAt, provider: saved.provider, model: saved.model });
      return reply.code(201).send({ image: saved, images: imagesOf(id), remaining: remaining() });
    } catch (error) {
      const message = error instanceof Error ? error.message : '配图生成失败';
      const saved = store.addImage({ ...base, id: randomUUID(), createdAt: new Date().toISOString(), status: 'failed', kind: 'generated', fileName: null, width: null, height: null, format: null, usage: null, parentId: previousInSlot?.id ?? null, restoredFromId: null, error: message });
      store.recordCapability('image', { status: 'failed', at: saved.createdAt, provider: saved.provider, model: saved.model, error: message });
      return reply.code(502).send({ error: `${slot.label}未生成：${message}`, image: saved, images: imagesOf(id), remaining: remaining() });
    } finally { pending.delete(id); }
  });

  app.post('/api/projects/:id/images/:imageId', async (req, reply) => {
    const { id, imageId } = z.object({ id: z.coerce.number().int().positive(), imageId: z.string() }).parse(req.params);
    const input = ImageActionSchema.parse(req.body);
    const project = store.project(id);
    if (!project) return reply.code(404).send({ error: '项目不存在' });
    const list = imagesOf(id);
    const source = list.find(item => item.id === imageId);
    if (!source) return reply.code(404).send({ error: '配图记录不存在' });
    if (input.action === 'restore') {
      const old = list.find(item => item.id === input.restoreImageId && item.slot === source.slot && item.materialVersionId === source.materialVersionId && item.status === 'succeeded' && item.fileName);
      if (!old) return reply.code(422).send({ error: '待恢复的旧图不存在或不属于同一张配图' });
      // 恢复不复制文件，旧记录与恢复记录共用同一份已落盘图片，历史版本仍可追溯。
      const restored: MaterialImage = { ...old, id: randomUUID(), createdAt: new Date().toISOString(), kind: 'restored', parentId: source.id, restoredFromId: old.id, instruction: '恢复历史配图', error: null };
      return reply.code(201).send({ image: store.addImage(restored), images: imagesOf(id) });
    }
    if (!imageConfigured(imageService)) return reply.code(422).send({ error: '生图服务未配置，无法修改配图' });
    if (pending.has(id)) return reply.code(409).send({ error: '该项目正在生成配图，请等待当前这张完成' });
    const version = store.materials(id).find(item => item.id === source.materialVersionId);
    if (!version) return reply.code(409).send({ error: '该配图对应的文案版本已不可用' });
    const slot = imageSlots.find(item => item.slot === source.slot)!;
    const brief = store.briefs(id)[0];
    pending.add(id);
    const style = store.effectiveVisualStyle(id);
    const prompt = composePrompt({
      platform: version.platform, projectUrl: project.url, purposes: brief ? briefPurposes(brief) : [], limitations: brief ? briefLimitations(brief) : [],
      titles: version.titles, body: version.body, slot, style,
      // 单张修改同时给出上一张的成图提示词，保持同一套视觉延续，只改经营者要求的部分。
      instruction: `请在保持这张配图整体构图与风格的前提下按以下要求修改，不要重画成另一张图。要求：${input.instruction} 上一版成图提示词：${source.prompt.slice(0, 600)}`,
    });
    // 默认把这张图本身作为编辑输入；显式选择参考图时改用参考图，由经营者决定替换还是叠加。
    const referencePaths = input.references.length ? input.references.map(name => referenceFile(root, name)) : source.fileName ? [resolveImageFile(root, id, source)] : [];
    const base = { projectId: id, platform: version.platform, materialVersionId: version.id, slot: slot.slot, prompt, instruction: input.instruction, provider: new URL(imageService.baseUrl).hostname, model: imageService.imageModel, inputSnapshot: { prompt, materialVersionId: version.id, style, previousImageId: source.id, references: input.references, usedPreviousImage: !input.references.length && !!source.fileName, textModel: imageService.model, configVersion: imageService.revision } };
    try {
      const image = await gate.run(`image:${imageService.baseUrl}:${imageService.imageModel}`, async () => {
        const generated = await generateImage(fetcher, imageService, prompt, referencePaths);
        const imageId = randomUUID();
        const fileName = saveGeneratedImage(root, id, generated, imageId);
        return { ...base, id: imageId, fileName, width: generated.width, height: generated.height, format: generated.format, usage: { response: generated.usage, revisedPrompt: generated.revisedPrompt } };
      });
      const saved = store.addImage({ ...image, createdAt: new Date().toISOString(), status: 'succeeded', kind: 'revised', parentId: source.id, restoredFromId: null, error: null });
      store.recordCapability('image', { status: 'succeeded', at: saved.createdAt, provider: saved.provider, model: saved.model });
      return reply.code(201).send({ image: saved, images: imagesOf(id) });
    } catch (error) {
      const message = error instanceof Error ? error.message : '配图修改失败';
      const saved = store.addImage({ ...base, id: randomUUID(), createdAt: new Date().toISOString(), status: 'failed', kind: 'revised', fileName: null, width: null, height: null, format: null, usage: null, parentId: source.id, restoredFromId: null, error: message });
      store.recordCapability('image', { status: 'failed', at: saved.createdAt, provider: saved.provider, model: saved.model, error: message });
      return reply.code(502).send({ error: `${slot.label}修改失败：${message}`, image: saved, images: imagesOf(id) });
    } finally { pending.delete(id); }
  });

  /** 图片文件只从服务端已登记记录读取，路径不接受调用方拼接。 */
  const sendImageFile = (req: { params: unknown; query: unknown }, reply: import('fastify').FastifyReply) => {
    const { id, imageId } = z.object({ id: z.coerce.number().int().positive(), imageId: z.string() }).parse(req.params);
    const query = z.object({ download: z.coerce.number().int().min(0).max(1).optional() }).parse(req.query);
    const image = imagesOf(id).find(item => item.id === imageId);
    if (!image || !image.fileName) return reply.code(404).send({ error: '该配图没有可用文件' });
    const buffer = readFileSync(resolveImageFile(root, id, image));
    // HTTP 头只能是 latin-1，中文文件名用 RFC 5987 编码，并保留纯 ASCII 回退名。
    const unicodeName = `${platformNames[image.platform]}-0${image.slot}-${imageSlots.find(item => item.slot === image.slot)?.label ?? '配图'}.${image.format ?? 'png'}`;
    const asciiName = `${image.platform}-0${image.slot}.${image.format ?? 'png'}`;
    return reply.type(`image/${image.format ?? 'png'}`)
      .header('content-disposition', `${query.download ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(unicodeName)}`)
      .send(buffer);
  };
  app.get('/api/projects/:id/images/:imageId/file', sendImageFile);

  // 支持一次导出多个选定版本（例如小红书一套 + 闲鱼一套），重复 version 参数即多选。
  app.get('/api/projects/:id/export', async (req, reply) => {
    const id = projectId(req.params);
    const query = z.object({ version: z.union([z.string(), z.array(z.string())]).transform(value => (Array.isArray(value) ? value : [value])) }).parse(req.query);
    const versions = store.materials(id).filter(item => query.version.includes(item.id));
    if (!versions.length) return reply.code(404).send({ error: '所选文案版本不存在或不属于该项目' });
    const archive = buildExportPackage(root, versions, imagesOf(id));
    const name = versions.length === 1 ? `material-${versions[0]!.platform}-${versions[0]!.id.slice(0, 8)}.zip` : `material-${versions.length}-sets.zip`;
    return reply.type('application/zip').header('content-disposition', `attachment; filename="${name}"`).send(archive);
  });
}

/** 对外导出只包含标题、正文和成图，不含证据 ID、内部资料、服务配置或研究备注。 */
export function buildExportPackage(root: string, versions: MaterialVersion[], images: MaterialImage[]) {
  const entries: { name: string; data: Buffer }[] = [];
  const used = new Set<string>();
  // 同名保护：同时导出同一平台的多个版本时，第二个起加版本短号，避免包内互相覆盖。
  const unique = (name: string, versionId: string) => {
    if (!used.has(name)) used.add(name);
    else {
      const dot = name.lastIndexOf('.');
      const renamed = `${name.slice(0, dot)}-${versionId.slice(0, 8)}${name.slice(dot)}`;
      used.add(renamed);
      return renamed;
    }
    return name;
  };
  for (const version of versions) {
    const folder = platformNames[version.platform];
    entries.push({ name: unique(safeZipName(folder, '文案.txt'), version.id), data: Buffer.from(`${version.titles.map((title, index) => `备选${index + 1}：${title}`).join('\n')}\n\n${version.body}\n`, 'utf8') });
    currentSet(version.id, images).forEach((image, index) => {
      if (!image?.fileName) return;
      entries.push({ name: unique(safeZipName(folder, `${String(index + 1).padStart(2, '0')}-${imageSlots[index]!.label}.${image.format ?? 'png'}`), version.id), data: readFileSync(resolveImageFile(root, image.projectId, image)) });
    });
  }
  return createZip(entries);
}

/** 每个槽位取最近一条记录，只有已成功且有文件的才算成套；失败槽位返回 null，由界面提示重试。 */
export function currentSet(materialVersionId: string, images: MaterialImage[]): (MaterialImage | null)[] {
  return imageSlots.map(({ slot }) => {
    const latest = latestForSlot(materialVersionId, slot, images);
    return latest && latest.status === 'succeeded' && latest.fileName ? latest : null;
  });
}

/** 同一槽位按时间倒序取最近一条记录（含失败记录），images 已按 slot 升序、时间倒序排列。 */
export function latestForSlot(materialVersionId: string, slot: number, images: MaterialImage[]) {
  return images.find(item => item.materialVersionId === materialVersionId && item.slot === slot) ?? null;
}

/** 待生成槽位序号：含失败记录，保证“只重试失败项”继续沿用同一序号。 */
function nextOpenSlot(materialVersionId: string, images: MaterialImage[]) {
  return imageSlots.findIndex(({ slot }) => latestForSlot(materialVersionId, slot, images)?.status !== 'succeeded');
}

function projectId(params: unknown) { return z.object({ id: z.coerce.number().int().positive() }).parse(params).id; }
