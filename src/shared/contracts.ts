import { z } from 'zod';

// 内容创作、办公自动化、个人效率为目标场景；other 表示不在目标范围，unknown 表示材料不足。
export const SceneSchema = z.enum(['content', 'office', 'productivity', 'other', 'unknown']);
export type Scene = z.infer<typeof SceneSchema>;
export const sceneLabels: Record<Scene, string> = { content: '内容创作', office: '办公自动化', productivity: '个人效率', other: '范围外', unknown: '待判断' };
// 优先实测、先核验、持续观察、暂不投入仅为 AI 建议，不覆盖人的决定。
export const RecommendationSchema = z.enum(['test', 'verify', 'watch', 'pass']);
export type Recommendation = z.infer<typeof RecommendationSchema>;
export const recommendationLabels: Record<Recommendation, string> = { test: '优先实测', verify: '先核验', watch: '持续观察', pass: '暂不投入' };
// 高、中、低是分维度判断；unknown 表示证据不足，不能当成低分。
export const LevelSchema = z.enum(['high', 'medium', 'low', 'unknown']);
export const dimensionKeys = ['demand', 'growth', 'contentGap', 'barriers', 'payment', 'reliability', 'fit', 'timing'] as const;
export const dimensionLabels: Record<typeof dimensionKeys[number], string> = { demand: '中国用户需求', growth: '增长质量', contentGap: '中文内容缺口', barriers: '使用与部署障碍', payment: '付费价值线索', reliability: '项目可靠性', fit: '交付适配度', timing: '选题时机' };
export const DimensionSchema = z.object({ key: z.enum(dimensionKeys), level: LevelSchema, reason: z.string().min(1), evidenceIds: z.array(z.string()) });
export const AnalysisContentSchema = z.object({
  scene: SceneSchema, sceneReason: z.string().min(1), recommendation: RecommendationSchema,
  summary: z.string().min(1), whyNow: z.string().min(1), audience: z.string().min(1), contentGap: z.string().min(1),
  deliverable: z.string().min(1), nextStep: z.string().min(1), costs: z.string().min(1),
  counterEvidence: z.array(z.string()).min(1), unknowns: z.array(z.string()).min(1), changeConditions: z.array(z.string()).min(1),
  dimensions: z.array(DimensionSchema).length(8), evidenceIds: z.array(z.string()),
}).superRefine((value, ctx) => { if (new Set(value.dimensions.map(d => d.key)).size !== 8) ctx.addIssue({ code: 'custom', message: '八项分析维度不能重复或缺失' }); });
export type AnalysisContent = z.infer<typeof AnalysisContentSchema>;
export interface Analysis extends AnalysisContent { id: string; projectId: number; createdAt: string; provider: string; model: string; ruleVersion: string; prediction: '暂不可预测'; usage: unknown; inputSnapshot?: unknown }
// repository 为项目官方材料；search 为检索返回的引用摘要；manual 为人工提供、未独立核验的材料。
export type EvidenceSource = 'repository' | 'search' | 'manual';
// full 表示已读取完整材料；excerpt 表示截取或摘要；unverified 表示尚未核验原文。
export type EvidenceCoverage = 'full' | 'excerpt' | 'unverified';
export interface Evidence { id: string; projectId: number; source: EvidenceSource; title: string; url: string; excerpt: string; query: string | null; collectedAt: string; coverage: EvidenceCoverage; limitation: string }
export interface Project { id: number; fullName: string; url: string; description: string; language: string | null; stars: number; dailyStars: number | null; sourceUrl: string; discoveredAt: string; lastSeenAt: string; scene: Scene; screeningReason?: string; latestAnalysis: Analysis | null; latestDecision: Decision | null; lastError: string | null }
// test=决定实测，watch=继续观察，pass=暂不投入；均为经营者保存的决定。
export const DecisionInputSchema = z.object({ analysisId: z.string().min(1), action: z.enum(['test', 'watch', 'pass']), reason: z.string().trim().min(1).max(3000) });
export type DecisionInput = z.infer<typeof DecisionInputSchema>;
export interface Decision extends DecisionInput { id: string; projectId: number; createdAt: string }
export const ManualEvidenceInputSchema = z.object({ title: z.string().trim().min(1).max(200), url: z.string().url().refine(v => ['http:', 'https:'].includes(new URL(v).protocol), '仅支持 HTTP(S) 链接'), excerpt: z.string().trim().min(1).max(10000) });
// queued=等待执行，running=执行中，succeeded=全部完成，partial=部分失败，failed=未能完成。
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';
// discover=自动发现并可继续分析，analyze=分析单个或一批已发现项目。
export type RunKind = 'discover' | 'analyze';
export interface Run { id: string; kind: RunKind; status: RunStatus; stage: string; startedAt: string; finishedAt: string | null; total: number; completed: number; errors: string[]; projectId: number | null }
export interface ProjectDetail { project: Project; evidence: Evidence[]; analyses: Analysis[]; decisions: Decision[] }
export interface StatusResponse { analysisConfigured: boolean; searchConfigured: boolean; analysisModel: string | null; searchModel: string | null; batchSize: number; activeRun: Run | null; latestRun: Run | null; projectCount: number; analyzedCount: number }
export interface ProjectsResponse { projects: Project[] }
export interface RunsResponse { runs: Run[] }
export interface ErrorResponse { error: string }

// observation 为真实采集快照；日榜增量与累计 Star 分开保存，不互相替代。
export interface Observation { projectId: number; observedAt: string; sourceUrl: string; stars: number; dailyStars: number | null }
// fact=材料明确说明；inference=根据材料推断；unknown=缺少可核验信息。
export const KnowledgeItemSchema = z.object({ text: z.string().min(1), certainty: z.enum(['fact', 'inference', 'unknown']), evidenceIds: z.array(z.string()) });
export const BriefContentSchema = z.object({
  purpose: z.array(KnowledgeItemSchema).min(1),
  environment: z.array(KnowledgeItemSchema).min(1),
  dependencies: z.array(KnowledgeItemSchema).min(1),
  limitations: z.array(KnowledgeItemSchema).min(1),
  pendingChecks: z.array(z.string()).min(1),
});
export interface ProjectBrief extends z.infer<typeof BriefContentSchema> { id: string; projectId: number; createdAt: string; provider: string; model: string; configVersion: string; usage: unknown; inputSnapshot: unknown }

// xiaohongshu=小红书草稿；xianyu=闲鱼草稿，均不代表平台审核通过。
export const PlatformSchema = z.enum(['xiaohongshu', 'xianyu']);
export type Platform = z.infer<typeof PlatformSchema>;
export const platformNames: Record<Platform, string> = { xiaohongshu: '小红书', xianyu: '闲鱼' };
export const PublicServiceSchema = z.object({ environment: z.string().max(2000).default(''), guidance: z.string().max(2000).default(''), exclusions: z.string().max(2000).default(''), price: z.string().max(500).default(''), timing: z.string().max(500).default(''), support: z.string().max(1000).default('') });
export type PublicService = z.infer<typeof PublicServiceSchema>;
export const MaterialContentSchema = z.object({ titles: z.array(z.string().min(1).max(200)).min(1).max(5), body: z.string().min(1).max(2000), evidenceIds: z.array(z.string()).min(1) });
// generated=首次生成；manual=人工编辑；revised=按补充要求修改；restored=从旧版恢复为新版本。
export type MaterialVersionKind = 'generated' | 'manual' | 'revised' | 'restored';
export interface MaterialVersion extends z.infer<typeof MaterialContentSchema> { id: string; projectId: number; platform: z.infer<typeof PlatformSchema>; createdAt: string; parentId: string | null; restoredFromId?: string; kind: MaterialVersionKind; instruction: string; provider: string | null; model: string | null; inputSnapshot: unknown; usage: unknown }

// pending=该槽位还没有图片；succeeded=已保存真实图片文件；failed=生成失败，可单独重试且不删除同批已成功图片。
export type ImageStatus = 'pending' | 'succeeded' | 'failed';
// generated=按文案首次生成；revised=按补充要求修改这一张；restored=把旧图恢复为新版本。
export type ImageVersionKind = 'generated' | 'revised' | 'restored';
export interface MaterialImage {
  id: string; projectId: number; platform: Platform; materialVersionId: string;
  // slot 为同一套素材内的图片序号，从 1 开始；重试与恢复只替换本槽位的历史记录。
  slot: number; status: ImageStatus; kind: ImageVersionKind;
  prompt: string; instruction: string; fileName: string | null;
  // 尺寸与格式记录网关真实返回值，不按提示词假定；未生成时为空。
  width: number | null; height: number | null; format: string | null;
  createdAt: string; parentId: string | null; restoredFromId: string | null;
  provider: string | null; model: string | null; usage: unknown; inputSnapshot: unknown; error: string | null;
}
// 参考图只接受经营者确认拥有使用权的图片，服务端原样保存，不做二次分发承诺。
export interface ReferenceImage { id: string; projectId: number | null; fileName: string; label: string; createdAt: string }
// succeeded=该能力的真实调用成功过；failed=最近一次真实调用失败并保留原因。二者都不等于“已配置即可用”。
export interface CapabilityCheck { status: 'succeeded' | 'failed'; at: string; provider: string | null; model: string | null; error?: string | null }
export type CapabilityKind = 'analysis' | 'search' | 'image';
export const VisualStyleSchema = z.object({ name: z.string().trim().max(100).default(''), direction: z.string().trim().max(2000).default(''), avoid: z.string().trim().max(2000).default('') });
export type VisualStyle = z.infer<typeof VisualStyleSchema>;
