import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { ImageServiceConfig } from './config.js';
import { platformNames, type MaterialImage, type Platform, type ProjectBrief, type VisualStyle } from '../shared/contracts.js';
import { request, readJson, type Fetch } from './http.js';

// 生图结果位于 image_generation_call.result（纯 base64），实测另有 size、output_format 与 revised_prompt。
const ResponseSchema = z.object({
  status: z.string(),
  usage: z.unknown().optional(),
  output: z.array(z.object({
    type: z.string(),
    status: z.string().optional(),
    result: z.string().optional(),
    revised_prompt: z.string().optional(),
    size: z.string().optional(),
    output_format: z.string().optional(),
  })).optional(),
});

export interface GeneratedImage { base64: string; revisedPrompt: string | null; width: number | null; height: number | null; format: string; usage: unknown }

/** 只接受 status=completed 且带真实图片字节的响应；缺任一条件都视为失败，不生成占位图。 */
export function parseImageResponse(raw: unknown): GeneratedImage {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error('生图服务响应结构无法识别，本次未保存图片');
  if (parsed.data.status !== 'completed') throw new Error(`生图未完成（服务状态 ${parsed.data.status}），已有图片保留，可只重试失败项`);
  const call = (parsed.data.output ?? []).find(item => item.type === 'image_generation_call' && item.status === 'completed' && item.result);
  if (!call?.result) throw new Error('服务没有返回真实图片数据，未保存占位图');
  const size = /^(\d+)x(\d+)$/.exec(call.size ?? '');
  return {
    base64: call.result,
    revisedPrompt: call.revised_prompt ?? null,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    format: call.output_format ?? 'png',
    usage: parsed.data.usage ?? null,
  };
}

/** 每个平台默认三张：封面、功能场景、使用条件提示，对应经营者真实交付判断，不做无意义凑数。 */
export const imageSlots = [
  { slot: 1, label: '封面主图', goal: '吸引目标用户点开，突出这个工具解决的现实问题' },
  { slot: 2, label: '功能场景图', goal: '示意主要使用场景与产出物，帮助读者理解它能做什么' },
  { slot: 3, label: '使用条件提示图', goal: '示意需要提前准备的环境或条件，不渲染成已经跑通的界面' },
] as const;

export function imageStorageRoot(databasePath: string) { return join(dirname(databasePath), 'materials'); }

/** 参考图仅接受服务端已登记且真实存在的文件，不接受调用方传入的任意路径。 */
export function referenceFile(root: string, fileName: string) { return join(root, 'references', basename(fileName)); }
/** 图片路径只由项目 ID、图片 ID 和已保存的扩展名拼出，文件名不可被请求参数控制。 */
export function resolveImageFile(root: string, projectId: number, image: Pick<MaterialImage, 'fileName'>) {
  if (!image.fileName) throw new Error('该配图尚未生成图片文件');
  return join(root, String(projectId), basename(image.fileName));
}

export function saveGeneratedImage(root: string, projectId: number, image: GeneratedImage, imageId: string) {
  const directory = join(root, String(projectId));
  mkdirSync(directory, { recursive: true });
  const fileName = `${imageId}.${image.format}`;
  writeFileSync(join(directory, fileName), Buffer.from(image.base64, 'base64'));
  return fileName;
}

export function composePrompt(input: {
  platform: Platform; projectUrl: string; purposes: string[]; limitations: string[];
  titles: string[]; body: string; slot: (typeof imageSlots)[number]; style: VisualStyle; instruction: string;
}) {
  const platformName = platformNames[input.platform];
  const headline = input.titles[0] ?? '';
  const lines = [
    `为中文平台「${platformName}」制作一张原创插画式配图，用途：${input.slot.label}。`,
    `画面目标：${input.slot.goal}。`,
    `介绍的工具：${input.projectUrl}，它的真实用途是：${input.purposes.join('；') || '（资料未说明）'}。`,
    `需要让读者理解的前提条件：${input.limitations.join('；') || '（资料未说明）'}。`,
    `配套文案标题：${headline || '（暂无）'}。配套正文（仅作理解用途，不要整段搬进画面）：${input.body}`,
    input.style.direction ? `整体视觉方向：${input.style.direction}。` : '整体视觉方向：简洁明亮、留白充足、主体突出，适合手机端竖版浏览。',
    input.style.avoid ? `需要避免：${input.style.avoid}。` : '',
    `画面中的中文文字最多使用这一句短标题，且必须逐字准确：${headline || '（不要出现任何文字）'}。`,
    '硬性要求：原创插画，不是截图；不要伪造软件真实界面、运行结果、终端输出、数据面板、用户数量、收益或评价；不要出现第三方商标或水印；文字若显示必须清晰可读、无错字、无乱码。',
    input.instruction ? `经营者的补充要求（在不违反上面的真实性要求前提下优先执行）：${input.instruction}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 生图请求结构与 2026-10-30 网关核验一致：Responses + 显式图片模型 + tool_choice=required + store:false。
 * imagePaths 必须是调用方已解析的绝对文件路径（参考图或上一版成图），不接受调用方直接拼路径。
 */
export async function generateImage(fetcher: Fetch, config: ImageServiceConfig, prompt: string, imagePaths: string[] = [], timeout = 300_000): Promise<GeneratedImage> {
  const references = imagePaths.map(path => {
    const format = mimeFormatOf(path);
    if (!format) throw new Error('图片输入格式不受支持，未发送请求');
    return `data:image/${format};base64,${readFileSync(path).toString('base64')}`;
  });
  const input = references.length
    ? [{ role: 'user', content: [{ type: 'input_text', text: prompt }, ...references.map(url => ({ type: 'input_image', image_url: url }))] }]
    : prompt;
  const response = await request(fetcher, `${config.baseUrl}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', ...(config.actorAuthorization ? { 'x-openai-actor-authorization': config.actorAuthorization } : {}) },
    body: JSON.stringify({ model: config.model, store: false, tools: [{ type: 'image_generation', model: config.imageModel }], tool_choice: 'required', input }),
  }, timeout);
  return parseImageResponse(await readJson(response));
}

/** 扩展名到图片 MIME 子类型；未知类型返回空串，由调用方拒绝。 */
export function mimeFormatOf(path: string) {
  const extension = path.split('.').pop()?.toLowerCase();
  return extension === 'jpg' || extension === 'jpeg' ? 'jpeg' : extension === 'png' ? 'png' : extension === 'webp' ? 'webp' : '';
}

/** 参考图片必须限制体积并使用真实图片扩展名，避免把任意文件塞进生图请求。 */
export const ReferenceInputSchema = z.object({
  label: z.string().trim().max(200).default(''),
  fileName: z.string().regex(/^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i, '参考图仅支持 PNG、JPG 或 WEBP'),
  data: z.string().min(1).max(8_000_000, '参考图过大，请压缩后上传'),
});

export function saveReferenceImage(root: string, input: z.infer<typeof ReferenceInputSchema>) {
  const bytes = Buffer.from(input.data, 'base64');
  // 按文件头判定类型，扩展名只用于客户端提示；两者不一致同样拒绝，避免伪装图片进入网关请求。
  const format = detectImageFormat(bytes);
  if (!format || format !== mimeFormatOf(input.fileName)) throw new Error('参考图内容不是受支持的 PNG/JPG/WEBP 图片，未保存');
  const id = randomUUID();
  mkdirSync(join(root, 'references'), { recursive: true });
  const fileName = `${id}.${format === 'jpeg' ? 'jpg' : format}`;
  writeFileSync(join(root, 'references', fileName), bytes);
  return { id, fileName, label: input.label, projectId: null as number | null, createdAt: new Date().toISOString() };
}

/** 按文件头识别图片类型，返回空串表示不受支持。 */
export function detectImageFormat(bytes: Buffer): 'png' | 'jpeg' | 'webp' | '' {
  if (bytes.length < 16) return '';
  if (bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG' && bytes.toString('ascii', 12, 16) === 'IHDR') return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return '';
}

/** 一张图的最终记录：图片数据落盘后才有 fileName，失败时保留原因供单独重试。 */
export function buildImage(base: Omit<MaterialImage, 'id' | 'createdAt' | 'status' | 'kind' | 'fileName' | 'parentId' | 'restoredFromId' | 'error'>, patch: Partial<Pick<MaterialImage, 'status' | 'kind' | 'fileName' | 'parentId' | 'restoredFromId' | 'error'>> = {}): MaterialImage {
  return { ...base, id: randomUUID(), createdAt: new Date().toISOString(), status: patch.status ?? 'succeeded', kind: patch.kind ?? 'generated', fileName: patch.fileName ?? null, parentId: patch.parentId ?? null, restoredFromId: patch.restoredFromId ?? null, error: patch.error ?? null };
}

export function briefPurposes(brief: ProjectBrief) { return brief.purpose.filter(item => item.certainty !== 'unknown').map(item => item.text); }
export function briefLimitations(brief: ProjectBrief) { return brief.limitations.map(item => item.text); }
