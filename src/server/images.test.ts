import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { detectImageFormat, parseImageResponse } from './images.js';
import { createZip } from './zip.js';
import { Store } from './store.js';
import type { ProjectBrief } from '../shared/contracts.js';
import type { Fetch } from './http.js';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4), Buffer.from('IHDR'), Buffer.alloc(4)]);
const item = { text: '用本地模型整理笔记', certainty: 'fact' as const, evidenceIds: ['e1'] };
const brief: ProjectBrief = { id: 'brief', projectId: 1, createdAt: '2026-10-30T00:00:00Z', purpose: [item], environment: [item], dependencies: [item], limitations: [{ ...item, text: '尚未实测部署' }], pendingChecks: ['核验许可证'], provider: 'test', model: 'test', configVersion: 'v1', usage: null, inputSnapshot: null };

/** 每个用例独立的临时目录，避免测试图片写入仓库工作区。 */
function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'radar-images-'));
  return { directory, databasePath: join(directory, 'radar.sqlite'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function seededStore(store: Store) {
  store.upsertProject({ id: 1, fullName: 'example/tool', url: 'https://github.com/example/tool', description: 'personal productivity', language: null, stars: 100, dailyStars: null, sourceUrl: 'https://github.com/trending', lastSeenAt: '2026-10-30T00:00:00Z' });
  store.addEvidence({ id: 'e1', projectId: 1, source: 'repository', title: 'README', url: 'https://github.com/example/tool', excerpt: '整理笔记', collectedAt: '2026-10-30T00:00:00Z', query: null, coverage: 'full', limitation: '作者声明' });
  store.addBrief(brief);
  const version = { id: 'text-v1', projectId: 1, platform: 'xiaohongshu' as const, titles: ['笔记整理工具'], body: '可以按主题整理本地笔记，需要配置协助可先说明场景。', evidenceIds: ['e1'], createdAt: '2026-10-30T01:00:00Z', parentId: null, kind: 'generated' as const, instruction: '', provider: 'test', model: 'test', inputSnapshot: null, usage: null };
  store.addMaterial(version);
  return version;
}

/** 生图响应按实测契约返回：图片字节在 image_generation_call.result。 */
const imageResponse = (status = 'completed') => new Response(JSON.stringify({
  status, usage: { total_tokens: 7363 },
  output: status === 'completed'
    ? [{ type: 'image_generation_call', status: 'completed', action: 'generate', result: png.toString('base64'), revised_prompt: '整理笔记主题插画', size: '1086x1448', output_format: 'png' }]
    : [{ type: 'image_generation_call', status: 'incomplete' }],
}));

it('生图使用显式图片模型与 GPT 网关凭据，不把备用服务密钥发往网关', async () => {
  const { databasePath, directory, cleanup } = workspace();
  const calls: { body: Record<string, unknown>; auth: string; hasImageInput: boolean }[] = [];
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ body, auth: String((init?.headers as Record<string, string>).authorization), hasImageInput: JSON.stringify(body.input).includes('input_image') });
    return imageResponse();
  }) as Fetch;
  const { app, store } = createApp({ config: loadConfig({ RADAR_DATABASE_PATH: databasePath, GPT_API_KEY: 'gpt-secret', GPT_BASE_URL: 'http://gateway.test/v1', GPT_MODEL: 'gpt-6.1-sol', GPT_IMAGE_MODEL: 'gpt-image-2.5-sunburst', AI_API_KEY: 'deepseek-secret', SEARCH_API_KEY: 'search-secret' }), fetch: fetcher });
  seededStore(store);
  try {
    const result = await app.inject({ method: 'POST', url: '/api/projects/1/images', payload: { action: 'generate', materialVersionId: 'text-v1', instruction: '顶部留白多一点' } });
    expect(result.statusCode).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ model: 'gpt-6.1-sol', store: false, tool_choice: 'required', tools: [{ type: 'image_generation', model: 'gpt-image-2.5-sunburst' }] });
    expect(calls[0]!.auth).toBe('Bearer gpt-secret');
    expect(JSON.stringify(calls[0]!.body)).not.toContain('deepseek-secret');
    expect(JSON.stringify(calls[0]!.body)).not.toContain('search-secret');
    expect(calls[0]!.hasImageInput).toBe(false);
    const image = result.json().image;
    expect(image).toMatchObject({ slot: 1, status: 'succeeded', width: 1086, height: 1448, format: 'png', model: 'gpt-image-2.5-sunburst', provider: 'gateway.test' });
    expect(readFileSync(join(directory, 'materials', '1', image.fileName))).toEqual(png);
    expect((await app.inject('/api/settings')).json()).toMatchObject({ images: { configured: true, imageModel: 'gpt-image-2.5-sunburst', capability: { status: 'succeeded' } } });
    // 接口与落盘记录都只保留主机名、模型与提示词，不含任何密钥。
    for (const probe of [await app.inject('/api/settings'), await app.inject('/api/projects/1/images'), await app.inject('/api/projects/1')]) {
      expect(probe.body).not.toMatch(/gpt-secret|deepseek-secret|search-secret/);
    }
    expect(JSON.stringify(store.images(1))).not.toMatch(/gpt-secret|Bearer /);
  } finally { await app.close(); cleanup(); }
});

it('第二张失败时保留第一张成图，重试只补失败那张', async () => {
  const { databasePath, cleanup } = workspace();
  let attempts = 0;
  const fetcher = (async () => { attempts++; return attempts === 2 ? new Response('{}', { status: 503 }) : imageResponse(); }) as Fetch;
  const { app, store } = createApp({ config: loadConfig({ RADAR_DATABASE_PATH: databasePath, GPT_API_KEY: 'gpt-secret' }), fetch: fetcher });
  seededStore(store);
  try {
    const first = await app.inject({ method: 'POST', url: '/api/projects/1/images', payload: { action: 'generate', materialVersionId: 'text-v1' } });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/api/projects/1/images', payload: { action: 'generate', materialVersionId: 'text-v1' } });
    expect(second.statusCode).toBe(502);
    const failed = second.json();
    expect(failed.error).toContain('功能场景图');
    expect(failed.image).toMatchObject({ slot: 2, status: 'failed', fileName: null });
    expect(failed.remaining).toBe(2);
    // 失败记录不删除已成功的第一张。
    expect(store.images(1).filter(image => image.status === 'succeeded')).toHaveLength(1);
    attempts = 0;
    const retry = await app.inject({ method: 'POST', url: '/api/projects/1/images', payload: { action: 'generate', materialVersionId: 'text-v1' } });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().image).toMatchObject({ slot: 2, status: 'succeeded' });
    expect(attempts).toBe(1);
  } finally { await app.close(); cleanup(); }
});

it('同一项目的配图请求未完成前拒绝重复提交', async () => {
  const { databasePath, cleanup } = workspace();
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const fetcher = (async () => { calls++; if (calls === 1) await held; return imageResponse(); }) as Fetch;
  const { app, store } = createApp({ config: loadConfig({ RADAR_DATABASE_PATH: databasePath, GPT_API_KEY: 'gpt-secret' }), fetch: fetcher });
  seededStore(store);
  try {
    const first = app.inject({ method: 'POST', url: '/api/projects/1/images', payload: { action: 'generate', materialVersionId: 'text-v1' } });
    await new Promise(resolve => setImmediate(resolve));
    const duplicate = await app.inject({ method: 'POST', url: '/api/projects/1/images', payload: { action: 'generate', materialVersionId: 'text-v1' } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toContain('正在生成配图');
    release();
    expect((await first).statusCode).toBe(201);
    expect(calls).toBe(1);
  } finally { await app.close(); cleanup(); }
});

it('修改这一张以原图为编辑输入并保留旧版，恢复旧图不重复落盘', async () => {
  const { databasePath, directory, cleanup } = workspace();
  const bodies: string[] = [];
  const fetcher = (async (_url, init) => { bodies.push(String(init?.body)); return imageResponse(); }) as Fetch;
  const { app, store } = createApp({ config: loadConfig({ RADAR_DATABASE_PATH: databasePath, GPT_API_KEY: 'gpt-secret' }), fetch: fetcher });
  seededStore(store);
  try {
    const original = (await app.inject({ method: 'POST', url: '/api/projects/1/images', payload: { action: 'generate', materialVersionId: 'text-v1' } })).json().image;
    const revised = (await app.inject({ method: 'POST', url: `/api/projects/1/images/${original.id}`, payload: { action: 'revise', imageId: original.id, instruction: '换成暖色背景' } })).json().image;
    expect(bodies[1]).toContain('input_image');
    expect(bodies[1]).toContain('换成暖色背景');
    expect(revised).toMatchObject({ slot: 1, kind: 'revised', parentId: original.id });
    const files = readdirSync(join(directory, 'materials', '1'));
    expect(files).toHaveLength(2);
    // 旧图文件仍可访问，界面据此提供恢复。
    const oldFile = await app.inject(`/api/projects/1/images/${original.id}/file`);
    expect(oldFile.statusCode).toBe(200);
    const restored = (await app.inject({ method: 'POST', url: `/api/projects/1/images/${revised.id}`, payload: { action: 'restore', restoreImageId: original.id } })).json().image;
    expect(restored).toMatchObject({ kind: 'restored', fileName: original.fileName, restoredFromId: original.id });
    expect(readdirSync(join(directory, 'materials', '1'))).toHaveLength(2);
    const mismatch = await app.inject({ method: 'POST', url: `/api/projects/1/images/${revised.id}`, payload: { action: 'restore', restoreImageId: 'other-slot' } });
    expect(mismatch.statusCode).toBe(422);
  } finally { await app.close(); cleanup(); }
});

it('服务未返回图片字节时报错且不写占位文件', async () => {
  const { databasePath, directory, cleanup } = workspace();
  const noBytes = (async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'image_generation_call', status: 'completed' }] }))) as Fetch;
  const { app, store } = createApp({ config: loadConfig({ RADAR_DATABASE_PATH: databasePath, GPT_API_KEY: 'gpt-secret' }), fetch: noBytes });
  seededStore(store);
  try {
    const result = await app.inject({ method: 'POST', url: '/api/projects/1/images', payload: { action: 'generate', materialVersionId: 'text-v1' } });
    expect(result.statusCode).toBe(502);
    expect(result.json().error).toContain('没有返回真实图片数据');
    expect(readdirSync(directory).some(name => name.endsWith('.png'))).toBe(false);
    expect(store.images(1)[0]).toMatchObject({ status: 'failed', fileName: null });
  } finally { await app.close(); cleanup(); }
});

it('只登记真实图片作为参考图，扩展名与内容不符时拒绝', async () => {
  const { databasePath, cleanup } = workspace();
  const { app, store } = createApp({ config: loadConfig({ RADAR_DATABASE_PATH: databasePath, GPT_API_KEY: 'gpt-secret' }), fetch: (async () => imageResponse()) as Fetch });
  seededStore(store);
  try {
    const fake = await app.inject({ method: 'POST', url: '/api/references', payload: { label: '伪装的脚本', fileName: 'evil.png', data: Buffer.from('#!/bin/sh\necho hi').toString('base64') } });
    expect(fake.statusCode).toBe(422);
    expect(store.referenceImages()).toHaveLength(0);
    const saved = await app.inject({ method: 'POST', url: '/api/references', payload: { label: '我自己的封面草图', fileName: 'sketch.png', data: png.toString('base64') } });
    expect(saved.statusCode).toBe(201);
    const served = await app.inject(`/api/references/${saved.json().fileName}`);
    expect(served.statusCode).toBe(200);
    // 未登记的名称即使格式合法也不得读到任何本地文件。
    expect((await app.inject('/api/references/unknown.png')).statusCode).toBe(404);
  } finally { await app.close(); cleanup(); }
});

it('导出包只含选定版本的文案与成图，不含内部备注与配置', async () => {
  const { databasePath, cleanup } = workspace();
  const { app, store } = createApp({ config: loadConfig({ RADAR_DATABASE_PATH: databasePath, GPT_API_KEY: 'gpt-secret' }), fetch: (async () => imageResponse()) as Fetch });
  seededStore(store);
  try {
    await app.inject({ method: 'PUT', url: '/api/service-profile', payload: { public: { guidance: '公开使用指导' }, internalNote: '内部经营备注不可公开' } });
    for (const slot of [1, 2]) await app.inject({ method: 'POST', url: '/api/projects/1/images', payload: { action: 'generate', materialVersionId: 'text-v1' } });
    const exported = await app.inject('/api/projects/1/export?version=text-v1');
    expect(exported.statusCode).toBe(200);
    const entries = readZip(exported.rawPayload);
    expect(entries.map(entry => entry.name)).toEqual(['小红书/文案.txt', '小红书/01-封面主图.png', '小红书/02-功能场景图.png']);
    const text = Buffer.from(entries[0]!.data).toString('utf8');
    expect(text).toContain('笔记整理工具');
    expect(text).not.toMatch(/内部经营备注|gpt-secret|evidenceIds|inputSnapshot|gateway/);
    expect(Buffer.from(entries[1]!.data)).toEqual(png);
    // 第三张未完成也允许导出已有内容，界面按实际张数提示。
    expect(entries).toHaveLength(3);
    expect((await app.inject('/api/projects/1/export?version=nope')).statusCode).toBe(404);
  } finally { await app.close(); cleanup(); }
});

/** 按中央目录解析 ZIP，验证写出结构可被读取且 CRC 一致。 */
function readZip(buffer: Buffer) {
  const end = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(-1);
  const count = buffer.readUInt16LE(end + 10);
  let pointer = buffer.readUInt32LE(end + 16);
  const entries: { name: string; data: Buffer }[] = [];
  for (let index = 0; index < count; index++) {
    expect(buffer.readUInt32LE(pointer)).toBe(0x02014b50);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const size = buffer.readUInt32LE(pointer + 24);
    const offset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(offset + 26);
    const start = offset + 30 + localNameLength;
    const data = buffer.subarray(start, start + size);
    expect(crc32(data)).toBe(buffer.readUInt32LE(pointer + 16));
    entries.push({ name, data: Buffer.from(data) });
    pointer += 46 + nameLength;
  }
  return entries;
}

it('生图响应解析区分未完成、无图片与真实成图', () => {
  expect(() => parseImageResponse({ status: 'failed', output: [] })).toThrow('生图未完成');
  expect(() => parseImageResponse({ status: 'completed', output: [{ type: 'message' }] })).toThrow('没有返回真实图片数据');
  expect(() => parseImageResponse('not an object')).toThrow('结构无法识别');
  const image = parseImageResponse(JSON.parse(JSON.stringify({ status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: png.toString('base64'), size: '1024x1024', output_format: 'webp' }] })));
  expect(image).toMatchObject({ width: 1024, height: 1024, format: 'webp' });
  expect(detectImageFormat(png)).toBe('png');
  expect(detectImageFormat(Buffer.from('#!/bin/sh'))).toBe('');
});

it('ZIP 写出对同名条目加版本短号，避免同平台多版本互相覆盖', () => {
  const archive = createZip([{ name: '小红书/文案.txt', data: Buffer.from('a') }, { name: '小红书/文案.txt', data: Buffer.from('b') }]);
  expect(archive.subarray(0, 4).toString('hex')).toBe('504b0304');
  expect(readZip(archive)).toHaveLength(2);
});
