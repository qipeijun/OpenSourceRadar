import { load } from 'cheerio';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Evidence, Scene } from '../shared/contracts.js';
import type { ProjectSeed } from './store.js';
import { request, readJson, type Fetch } from './http.js';

export const TRENDING_URL = 'https://github.com/trending?since=daily';
export interface TrendingEntry { fullName: string; dailyStars: number | null }
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseTrending(html: string): TrendingEntry[] {
  const $ = load(html);
  const rows = $('article.Box-row');
  if (!rows.length) {
    if ($('main').text().includes('No repositories found')) return [];
    throw new Error('GitHub Trending 页面结构未识别，不能将解析失败视为没有项目');
  }
  const result: TrendingEntry[] = [];
  rows.each((_index, row) => {
    const path = $(row).find('h2 a').attr('href')?.replace(/^\//, '');
    if (!path || !repositoryName.test(path)) throw new Error('GitHub Trending 项目链接格式变化');
    const match = $(row).text().match(/([\d,]+)\s+stars? today/i);
    result.push({ fullName: path, dailyStars: match ? Number(match[1]!.replaceAll(',', '')) : null });
  });
  return [...new Map(result.map(entry => [entry.fullName.toLowerCase(), entry])).values()];
}

export async function discover(fetcher: Fetch): Promise<TrendingEntry[]> {
  const response = await request(fetcher, TRENDING_URL, { headers: { 'user-agent': 'OpenSourceRadar/0.1', accept: 'text/html' } });
  return parseTrending(await response.text());
}

const RepositorySchema = z.object({ id: z.number().int().positive(), full_name: z.string().regex(repositoryName), description: z.string().nullable(), language: z.string().nullable(), stargazers_count: z.number().int().nonnegative(), archived: z.boolean(), pushed_at: z.string().nullable(), license: z.object({ spdx_id: z.string() }).nullable() });
function headers(token?: string) { return { accept: 'application/vnd.github+json', 'user-agent': 'OpenSourceRadar/0.1', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) }; }
export async function getRepository(fetcher: Fetch, entry: TrendingEntry, token?: string): Promise<{ seed: ProjectSeed; evidence: Evidence }> {
  if (!repositoryName.test(entry.fullName)) throw new Error('仓库名称无效');
  const response = await request(fetcher, `https://api.github.com/repos/${entry.fullName}`, { headers: headers(token) });
  const parsed = RepositorySchema.safeParse(await readJson(response));
  if (!parsed.success) throw new Error('GitHub 仓库详情字段不完整，未保存未知 Star 数为零');
  const repo = parsed.data;
  const now = new Date().toISOString();
  const url = `https://github.com/${repo.full_name}`;
  return {
    seed: { id: repo.id, fullName: repo.full_name, url, description: repo.description ?? '', language: repo.language, stars: repo.stargazers_count, dailyStars: entry.dailyStars, sourceUrl: TRENDING_URL, lastSeenAt: now },
    evidence: { id: randomUUID(), projectId: repo.id, source: 'repository', title: 'GitHub 仓库信息', url, collectedAt: now, query: null, coverage: 'excerpt', limitation: '官方 API 元数据及榜单当日增量，不代表使用量或持续增长；尚未实测。', excerpt: JSON.stringify({ ...repo, trendingDailyStars: entry.dailyStars }) },
  };
}

export async function getReadme(fetcher: Fetch, id: number, fullName: string, token?: string): Promise<Evidence> {
  if (!repositoryName.test(fullName)) throw new Error('仓库名称无效');
  const response = await request(fetcher, `https://api.github.com/repos/${fullName}/readme`, { headers: headers(token) });
  const parsed = z.object({ content: z.string(), encoding: z.literal('base64'), sha: z.string() }).safeParse(await readJson(response));
  if (!parsed.success) throw new Error('GitHub README 内容格式不受支持');
  const content = Buffer.from(parsed.data.content, 'base64').toString('utf8');
  return { id: randomUUID(), projectId: id, source: 'repository', title: `README · ${parsed.data.sha.slice(0, 7)}`, url: `https://github.com/${fullName}#readme`, excerpt: content.slice(0, 24000), query: null, collectedAt: new Date().toISOString(), coverage: content.length > 24000 ? 'excerpt' : 'full', limitation: '项目作者声明，未经本地安装验证。' + (content.length > 24000 ? '仅截取前 24000 字符。' : '') };
}

/** 仅作可解释的初筛，不把关键词命中当作真实需求证据；未知项目保留探索名额。 */
export function screenProject(description: string): { scene: Scene; reason: string } {
  const rules: [Scene, RegExp, string][] = [
    ['content', /video|image|audio|music|creat(?:or|ion)|design|图像|视频|写作|创作|音频/i, '简介含内容创作相关词'],
    ['office', /workflow|spreadsheet|document|presentation|automation|办公|文档|表格|自动化/i, '简介含办公与自动化相关词'],
    ['productivity', /note|knowledge|productivity|personal|research|assistant|笔记|知识|效率|助手/i, '简介含个人效率相关词'],
    ['other', /\bcompiler\b|\bkernel\b|\bdatabase engine\b|\bdistributed database\b|底层库|编译器|内核/i, '简介显示主要为底层开发基础设施'],
  ];
  const match = rules.find(([, pattern]) => pattern.test(description));
  return match ? { scene: match[0], reason: `${match[2]}，待完整材料核验` } : { scene: 'unknown', reason: '简介不足以判断目标场景，保留为探索候选' };
}
