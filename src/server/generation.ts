import { z } from 'zod';
import type { AIServiceConfig } from './config.js';
import { request, readJson, type Fetch } from './http.js';

const ResponsesSchema = z.object({ status: z.literal('completed'), usage: z.unknown().optional(), output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() })) });
const ChatSchema = z.object({ usage: z.unknown().optional(), choices: z.array(z.object({ finish_reason: z.literal('stop'), message: z.object({ content: z.string() }) })).min(1) });

/** 统一生成 JSON；只有服务端配置可以决定目的地址、模型和鉴权。 */
export async function generateJson(fetcher: Fetch, config: AIServiceConfig, system: string, input: unknown) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }];
  const responses = config.wire === 'responses';
  const body = responses ? { model: config.model, store: false, input: messages, text: { format: { type: 'json_object' } } } : { model: config.model, messages, response_format: { type: 'json_object' } };
  const response = await request(fetcher, `${config.baseUrl}/${responses ? 'responses' : 'chat/completions'}`, {
    method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', ...(config.actorAuthorization ? { 'x-openai-actor-authorization': config.actorAuthorization } : {}) }, body: JSON.stringify(body),
  }, 120_000);
  const raw = await readJson(response);
  let text: string;
  let usage: unknown;
  if (responses) {
    const parsed = ResponsesSchema.safeParse(raw);
    if (!parsed.success) throw new Error('生成未完整结束，请重试；已有内容未被覆盖');
    text = parsed.data.output.flatMap(item => item.type === 'message' ? item.content ?? [] : []).filter(item => item.type === 'output_text').map(item => item.text ?? '').join('');
    usage = parsed.data.usage ?? null;
  } else {
    const parsed = ChatSchema.safeParse(raw);
    if (!parsed.success) throw new Error('生成未完整结束，请重试；已有内容未被覆盖');
    text = parsed.data.choices[0]!.message.content;
    usage = parsed.data.usage ?? null;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('服务未返回合法 JSON，请重试；已有内容未被覆盖'); }
  return { value, usage, inputSnapshot: { messages, provider: new URL(config.baseUrl).hostname, model: config.model, configVersion: config.revision ?? 'chat-v1' } };
}
