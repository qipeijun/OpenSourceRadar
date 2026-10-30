import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import type { MaterialImage, MaterialVersion, ProjectBrief } from '../src/shared/contracts.js';

/**
 * 真实素材闭环验收：对已发现并已有中文资料的真实候选，走完
 * 双平台文案 → 人工编辑 → 按范围修改 → 恢复旧版 → 三张配图 → 单张修改 → 恢复旧图 → 打包导出。
 * 结果只记录脱敏摘要与实际文件路径，图片效果须另行查看文件确认，不以接口成功代替效果核对。
 */
const target = process.env.MATERIAL_PROJECT ?? 'HKUDS/DeepTutor';
const config = loadConfig();
const check = new DatabaseSync(config.databasePath, { readOnly: true });
const running = check.prepare('SELECT body FROM runs').all().some(row => ['running', 'queued'].includes(JSON.parse(String(row.body)).status));
const projects = check.prepare('SELECT body FROM projects').all().map(row => JSON.parse(String(row.body)) as { id: number; fullName: string });
check.close();
if (running) throw new Error('已有运行中任务，本次验收停止，避免并发写入');
const found = projects.find(item => item.fullName === target);
if (!found) throw new Error(`未在系统已发现的候选中找到 ${target}，不构造项目替代`);

const { app, store } = createApp({ config });
const report: Record<string, unknown> = { at: new Date().toISOString(), project: target, projectId: found.id, steps: [] as string[] };
const steps = report.steps as string[];
const post = async <T>(url: string, payload: unknown) => {
  const response = await app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> });
  if (response.statusCode >= 400) throw new Error(`${url} → HTTP ${response.statusCode} ${response.body.slice(0, 300)}`);
  return response.json() as T;
};

try {
  let brief = store.briefs(found.id)[0];
  if (!brief) {
    brief = await post<ProjectBrief>(`/api/projects/${found.id}/briefs`, {});
    steps.push(`生成中文资料 ${brief.id}`);
  } else steps.push(`沿用已生成的中文资料 ${brief.id}`);

  const texts: Record<string, MaterialVersion> = {};
  for (const platform of ['xiaohongshu', 'xianyu'] as const) {
    const generated = await post<MaterialVersion>(`/api/projects/${found.id}/materials`, { action: 'generate', platform, instruction: '' });
    steps.push(`生成${platform}文案 ${generated.id}`);
    const edited = await post<MaterialVersion>(`/api/projects/${found.id}/materials`, { action: 'manual', baseVersionId: generated.id, titles: generated.titles, body: `${generated.body}\n（人工补充：先按你自己的系统版本核对。）` });
    steps.push(`${platform}人工编辑 ${edited.id}`);
    const revised = await post<MaterialVersion>(`/api/projects/${found.id}/materials`, { action: 'revise', baseVersionId: edited.id, scope: 'titles', instruction: '标题再短一些，突出省时' });
    steps.push(`${platform}只改标题 ${revised.id}，正文是否保持人工编辑：${revised.body === edited.body}`);
    const restored = await post<MaterialVersion>(`/api/projects/${found.id}/materials`, { action: 'restore', baseVersionId: revised.id, restoreVersionId: edited.id });
    steps.push(`${platform}恢复人工编辑版为 ${restored.id}`);
    texts[platform] = restored;
  }

  const imageReports: Record<string, unknown> = {};
  for (const [platform, version] of Object.entries(texts)) {
    const set: unknown[] = [];
    for (;;) {
      const response = await app.inject({ method: 'POST', url: `/api/projects/${found.id}/images`, payload: { action: 'generate', materialVersionId: version.id, instruction: '' } });
      const body = response.json() as { image: MaterialImage; images: MaterialImage[]; remaining: number; error?: string };
      set.push({ slot: body.image.slot, status: body.image.status, httpStatus: response.statusCode, file: body.image.fileName, width: body.image.width, height: body.image.height, model: body.image.model, provider: body.image.provider, error: body.image.error });
      if (body.error || !body.remaining) break;
    }
    imageReports[platform] = { materialVersionId: version.id, attempts: set };
    steps.push(`${platform} 配图尝试 ${set.length} 次`);
  }

  // 单张修改与旧图恢复：只在至少有一张成功成图时执行，失败不伪造。
  const images = store.images(found.id).filter(item => item.status === 'succeeded');
  if (images.length) {
    const first = images[0];
    const revised = await post<{ image: MaterialImage }>(`/api/projects/${found.id}/images/${first.id}`, { action: 'revise', instruction: '把整体色调换成更暖的浅色，其余构图保持不变' });
    steps.push(`单张修改 ${first.id} → ${revised.image.id}（${revised.image.status}）`);
    const back = await post<{ image: MaterialImage }>(`/api/projects/${found.id}/images/${revised.image.id}`, { action: 'restore', restoreImageId: first.id });
    steps.push(`恢复旧图 → ${back.image.id}，复用文件 ${back.image.fileName}`);
    report.singleImageDemo = { original: first.id, originalFile: first.fileName, revised: revised.image.id, revisedFile: revised.image.fileName, revisedStatus: revised.image.status, restored: back.image.id };
  }

  for (const [platform, version] of Object.entries(texts)) {
    const exported = await app.inject(`/api/projects/${found.id}/export?version=${version.id}`);
    const path = join('data', 'exports', `${platform}-${version.id.slice(0, 8)}.zip`);
    mkdirSync(join('data', 'exports'), { recursive: true });
    writeFileSync(path, exported.rawPayload);
    report[`${platform}Export`] = { statusCode: exported.statusCode, bytes: exported.rawPayload.length, path };
    steps.push(`${platform} 导出 ${exported.statusCode} · ${exported.rawPayload.length} 字节 → ${path}`);
  }
  report.texts = Object.fromEntries(Object.entries(texts).map(([platform, version]) => [platform, { id: version.id, titles: version.titles, body: version.body, kind: version.kind }]));
} finally {
  await app.close();
  mkdirSync('docs/development/evidence', { recursive: true });
  writeFileSync('docs/development/evidence/material-package-20261030.json', JSON.stringify({ ...report, steps }, null, 2) + '\n');
  console.log(JSON.stringify(steps, null, 2));
}
