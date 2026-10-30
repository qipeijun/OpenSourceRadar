import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/server/config.js';
import { request, readJson } from '../src/server/http.js';

/**
 * 契约取样：前一轮能力核验只记录了“有图片字节”，没有保存图片数据所在字段。
 * 实现解析前必须核实真实响应结构，不猜字段名。只发一次生成请求，同时产出可直接用于视觉核对的 PNG。
 * 提示词贴近真实用途（中文推广封面），用于判断生图质量是否可用，而不只看接口成功。
 */
const config = loadConfig();
const gpt = config.providers?.gpt;
if (!gpt?.apiKey) throw new Error('GPT 网关未配置凭据');
const imageModel = process.env.PROBE_IMAGE_MODEL || 'gpt-image-2.5-sunburst';
const prompt = '为中文技术分享制作一张竖版封面图：浅色简洁背景，中央一个笔记本电脑轮廓，屏幕里显示发光的文档页面，周围有若干小图标。画面顶部留出一条空白区域，用于后期添加标题。不要出现任何文字、字母或数字。';

const t0 = Date.now();
const response = await request(globalThis.fetch, `${gpt.baseUrl}/responses`, {
  method: 'POST',
  headers: { authorization: `Bearer ${gpt.apiKey}`, 'content-type': 'application/json', ...(gpt.actorAuthorization ? { 'x-openai-actor-authorization': gpt.actorAuthorization } : {}) },
  body: JSON.stringify({ model: gpt.model, store: false, tools: [{ type: 'image_generation', model: imageModel }], tool_choice: 'required', input: prompt }),
}, 180_000);
const raw = await readJson(response);

/** 只保留结构与长度，base64 正文替换为占位，避免把图片字节写进证据文件。 */
function describe(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map(item => describe(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      if (typeof v === 'string' && v.length > 200) return [k, `[base64 或长文本，长度 ${v.length}，前缀 ${v.slice(0, 24)}]`];
      return [k, describe(v, k)];
    }));
  }
  return value;
}

const output = (raw as { output?: unknown[] }).output ?? [];
const imageParts: string[] = [];
for (const item of output as Record<string, unknown>[]) {
  if (typeof item.result === 'string' && item.result.length > 200) imageParts.push(item.result);
  for (const part of (item.content ?? []) as Record<string, unknown>[]) if (typeof part === 'object' && typeof part.text === 'string' && part.text.length > 200) imageParts.push(part.text);
}
mkdirSync('data/capability-probes', { recursive: true });
mkdirSync('docs/development/evidence', { recursive: true });
const files = imageParts.map((b64, index) => {
  const path = `data/capability-probes/cover-${index + 1}.png`;
  writeFileSync(path, Buffer.from(b64, 'base64'));
  return { path, bytes: Buffer.from(b64, 'base64').length };
});
writeFileSync('docs/development/evidence/image-contract-20261030.json', JSON.stringify({
  at: new Date().toISOString(), elapsedMs: Date.now() - t0,
  request: { model: gpt.model, store: false, tools: [{ type: 'image_generation', model: imageModel }], tool_choice: 'required', prompt },
  headers: ['authorization: [已脱敏]', 'x-openai-actor-authorization: [已配置]'],
  responseShape: describe(raw),
  imageParts: files,
}, null, 2) + '\n');
console.log(JSON.stringify({ elapsedMs: Date.now() - t0, status: (raw as { status?: string }).status, images: files.length, files }));
