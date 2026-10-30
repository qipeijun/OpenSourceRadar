import { z } from 'zod';

export interface AIServiceConfig {
  baseUrl: string; apiKey: string; model: string;
  // responses 为 GPT 网关协议；chat 为现有 DeepSeek Chat Completions 协议。
  wire?: 'responses' | 'chat'; actorAuthorization?: string; revision?: string;
}

// 生图需要两个模型：model 是发起 Responses 工具调用的文本模型，imageModel 是工具内显式指定的图片模型。
export interface ImageServiceConfig {
  baseUrl: string; apiKey: string; model: string; imageModel: string;
  actorAuthorization?: string; revision: string;
}

export interface Config {
  port: number; databasePath: string; batchSize: number; githubToken?: string;
  analysis: AIServiceConfig;
  providers?: { gpt: AIServiceConfig; deepseek: AIServiceConfig };
  search: AIServiceConfig;
  // 生图与文本模型是不同能力：地址与凭据沿用已核验的 GPT 网关，图片模型名单独配置，绝不从文本模型名推断。
  image: ImageServiceConfig;
}
const baseUrl = (value: string) => z.string().url().refine(v => ['https:', 'http:'].includes(new URL(v).protocol) && !new URL(v).username && !new URL(v).password).parse(value).replace(/\/$/, '');
const openAIBaseUrl = 'https://api.openai.com/v1';
const defaultModel = 'gpt-4.1-mini';
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const analysisBaseUrl = baseUrl(env.AI_BASE_URL?.trim() || openAIBaseUrl);
  const searchBaseUrl = baseUrl(env.SEARCH_BASE_URL?.trim() || openAIBaseUrl);
  const analysisKey = env.AI_API_KEY?.trim() || '';
  // 同一官方服务只填一次密钥；混用服务或自定义地址须显式提供检索密钥，避免跨服务传递。
  const canShareKey = analysisBaseUrl === searchBaseUrl && [openAIBaseUrl, 'https://api.deepseek.com'].includes(analysisBaseUrl);
  const sharedKey = canShareKey ? analysisKey : '';
  const deepseek: AIServiceConfig = { baseUrl: analysisBaseUrl, apiKey: analysisKey, model: env.AI_MODEL?.trim() || (analysisBaseUrl === openAIBaseUrl ? defaultModel : '') };
  const gpt: AIServiceConfig = { baseUrl: baseUrl(env.GPT_BASE_URL?.trim() || openAIBaseUrl), apiKey: env.GPT_API_KEY?.trim() || '', model: env.GPT_MODEL?.trim() || 'gpt-6.1-sol', wire: 'responses', actorAuthorization: env.GPT_ACTOR_AUTHORIZATION?.trim(), revision: 'gpt-responses-v1' };
  if (env.GPT_WIRE_API && env.GPT_WIRE_API !== 'responses') throw new Error('GPT_WIRE_API 必须为 responses');
  if (env.GPT_STORE_RESPONSES && env.GPT_STORE_RESPONSES !== 'false') throw new Error('GPT 响应存储必须关闭');
  return {
    port: z.coerce.number().int().min(1).max(65535).parse(env.PORT ?? 4310),
    databasePath: env.RADAR_DATABASE_PATH ?? './data/radar.sqlite',
    batchSize: z.coerce.number().int().min(1).max(100).parse(env.RADAR_BATCH_SIZE ?? 10),
    githubToken: env.GITHUB_TOKEN,
    analysis: gpt.apiKey ? gpt : deepseek,
    providers: { gpt, deepseek },
    search: { baseUrl: searchBaseUrl, apiKey: env.SEARCH_API_KEY?.trim() || sharedKey, model: env.SEARCH_MODEL?.trim() || (searchBaseUrl === openAIBaseUrl ? defaultModel : '') },
    image: {
      baseUrl: gpt.baseUrl, apiKey: gpt.apiKey, model: gpt.model,
      // 图片模型必须显式配置为网关目录中真实存在的生图模型；置空即视为未接入，不回落到文本模型。
      imageModel: env.GPT_IMAGE_MODEL?.trim() ?? 'gpt-image-2.5-sunburst',
      actorAuthorization: gpt.actorAuthorization, revision: 'image-responses-v1',
    },
  };
}

export const isConfigured = (service: { apiKey: string; model: string }) => Boolean(service.apiKey && service.model);
export const imageConfigured = (service: Config['image']) => Boolean(service.apiKey && service.model && service.imageModel);
