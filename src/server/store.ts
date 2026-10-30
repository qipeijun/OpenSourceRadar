import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CapabilityCheck, CapabilityKind, MaterialImage, MaterialVersion, PublicService, Observation, ProjectBrief, Analysis, Decision, DecisionInput, Evidence, Project, ProjectDetail, Run, ReferenceImage, VisualStyle } from '../shared/contracts.js';
import { screenProject } from './github.js';

export type ProjectSeed = Omit<Project, 'scene' | 'latestAnalysis' | 'latestDecision' | 'lastError' | 'discoveredAt'>;

/** 项目身份来自 GitHub 数字 ID，仓库改名时更新同一条记录；分析与人工决定只追加。 */
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ref_images (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS briefs (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS evidence_project ON evidence(project_id);
      CREATE INDEX IF NOT EXISTS analyses_project ON analyses(project_id);
      CREATE INDEX IF NOT EXISTS decisions_project ON decisions(project_id);`);
    // 进程中断留下的运行不能在重启后继续显示为执行中。
    for (const run of this.runs()) if (['queued', 'running'].includes(run.status)) this.saveRun({ ...run, status: 'failed', finishedAt: new Date().toISOString(), errors: [...run.errors, '上次运行因本地服务停止而中断，请重新发起'] });
  }
  analysisProvider(): 'gpt' | 'deepseek' | null { const row = this.db.prepare("SELECT body FROM settings WHERE id = ?").get('analysisProvider'); return row ? JSON.parse(String(row.body)) : null; }
  setAnalysisProvider(provider: 'gpt' | 'deepseek') { this.write('settings', 'analysisProvider', provider); }
  // configured 使用独立 SEARCH_* 配置；gpt 显式选择 GPT 网关检索，不随分析服务切换。
  searchProvider(): 'configured' | 'gpt' { const row = this.db.prepare("SELECT body FROM settings WHERE id = ?").get('searchProvider'); return row ? JSON.parse(String(row.body)) : 'configured'; }
  setSearchProvider(provider: 'configured' | 'gpt') { this.write('settings', 'searchProvider', provider); }
  close() { this.db.close(); }
  private rows<T>(table: string, projectId?: number): T[] {
    const rows = projectId === undefined ? this.db.prepare(`SELECT body FROM ${table} ORDER BY rowid DESC`).all() : this.db.prepare(`SELECT body FROM ${table} WHERE project_id = ? ORDER BY rowid DESC`).all(projectId);
    return rows.map(row => JSON.parse(String(row.body)) as T);
  }
  private write(table: string, id: string | number, body: unknown, projectId?: number) {
    if (projectId === undefined) this.db.prepare(`INSERT INTO ${table}(id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(id, JSON.stringify(body));
    else this.db.prepare(`INSERT INTO ${table}(id, project_id, body) VALUES (?, ?, ?)`).run(id, projectId, JSON.stringify(body));
  }
  projects(): Project[] { return this.rows<Project>('projects').sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || (b.dailyStars ?? -1) - (a.dailyStars ?? -1)); }
  project(id: number): Project | null { const row = this.db.prepare('SELECT body FROM projects WHERE id = ?').get(id); return row ? JSON.parse(String(row.body)) as Project : null; }
  upsertProject(seed: ProjectSeed): Project {
    const old = this.project(seed.id);
    const screening = screenProject(seed.description);
    const next: Project = { ...seed, discoveredAt: old?.discoveredAt ?? seed.lastSeenAt, scene: old?.latestAnalysis?.scene ?? screening.scene, screeningReason: screening.reason, latestAnalysis: old?.latestAnalysis ?? null, latestDecision: old?.latestDecision ?? null, lastError: old?.lastError ?? null };
    this.write('projects', next.id, next);
    this.addObservation({ projectId: seed.id, observedAt: seed.lastSeenAt, sourceUrl: seed.sourceUrl, stars: seed.stars, dailyStars: seed.dailyStars });
    return next;
  }
  setProjectError(id: number, error: string | null) { const project = this.project(id); if (project) this.write('projects', id, { ...project, lastError: error }); }
  evidence(id: number): Evidence[] { return this.rows<Evidence>('evidence', id); }
  addEvidence(evidence: Evidence) { this.write('evidence', evidence.id, evidence, evidence.projectId); return evidence; }
  addAnalysis(analysis: Analysis) {
    const project = this.project(analysis.projectId); if (!project) throw new Error('项目不存在');
    this.db.exec('BEGIN');
    try { this.write('analyses', analysis.id, analysis, analysis.projectId); this.write('projects', project.id, { ...project, scene: analysis.scene, latestAnalysis: analysis, lastError: null }); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  addDecision(projectId: number, input: DecisionInput): Decision {
    const project = this.project(projectId); if (!project) throw new Error('项目不存在');
    const analysis = this.db.prepare('SELECT id FROM analyses WHERE id = ? AND project_id = ?').get(input.analysisId, projectId);
    if (!analysis) throw new Error('分析版本不属于该项目');
    const decision: Decision = { ...input, id: randomUUID(), projectId, createdAt: new Date().toISOString() };
    this.db.exec('BEGIN');
    try { this.write('decisions', decision.id, decision, projectId); this.write('projects', project.id, { ...project, latestDecision: decision }); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return decision;
  }
  detail(id: number): ProjectDetail | null { const project = this.project(id); return project ? { project, evidence: this.evidence(id), analyses: this.rows<Analysis>('analyses', id), decisions: this.rows<Decision>('decisions', id) } : null; }
  serviceProfile(): { public: PublicService; internalNote: string } | null { const row = this.db.prepare("SELECT body FROM settings WHERE id = ?").get('serviceProfile'); return row ? JSON.parse(String(row.body)) : null; }
  setServiceProfile(profile: { public: PublicService; internalNote: string }) { this.write('settings', 'serviceProfile', profile); }
  materials(projectId: number) { return this.rows<MaterialVersion>('materials', projectId); }
  addMaterial(material: MaterialVersion) { this.write('materials', material.id, material, material.projectId); return material; }
  /** 配图历史按版本时间排列；同一槽位的最新记录由调用方筛选。 */
  images(projectId: number) { return this.rows<MaterialImage>('images', projectId).sort((a, b) => a.slot - b.slot || b.createdAt.localeCompare(a.createdAt)); }
  addImage(image: MaterialImage) { this.write('images', image.id, image, image.projectId); return image; }
  referenceImages(): ReferenceImage[] { return this.rows<ReferenceImage>('ref_images'); }
  addReferenceImage(image: ReferenceImage) { this.write('ref_images', image.id, image); return image; }
  /** 视觉风格：projectId 省略时读写全局可复用配置，提供时只读写该项目自己的调整，未设置返回 null。 */
  visualStyle(projectId?: number): VisualStyle | null {
    const key = projectId === undefined ? 'visualStyle' : `visualStyle:project:${projectId}`;
    const row = this.db.prepare('SELECT body FROM settings WHERE id = ?').get(key);
    return row ? (JSON.parse(String(row.body)) as VisualStyle) : null;
  }
  /** 配图实际使用的风格：项目级调整优先，否则沿用全局。 */
  effectiveVisualStyle(projectId: number) { return this.visualStyle(projectId) ?? this.visualStyle() ?? { name: '', direction: '', avoid: '' }; }
  setVisualStyle(style: VisualStyle, projectId?: number) { this.write('settings', projectId === undefined ? 'visualStyle' : `visualStyle:project:${projectId}`, style); }
  /** 记录某项能力最近一次真实调用的结果，用于区分“已配置”和“已核验”。 */
  capabilities(): Partial<Record<CapabilityKind, CapabilityCheck>> {
    const row = this.db.prepare("SELECT body FROM settings WHERE id = ?").get('capabilities');
    return row ? JSON.parse(String(row.body)) : {};
  }
  recordCapability(kind: CapabilityKind, check: CapabilityCheck) {
    const current = this.capabilities();
    this.write('settings', 'capabilities', { ...current, [kind]: check });
  }
  addObservation(observation: Observation) {
    const id = JSON.stringify([observation.projectId, observation.observedAt, observation.sourceUrl]);
    this.db.prepare('INSERT OR IGNORE INTO observations(id, project_id, body) VALUES (?, ?, ?)').run(id, observation.projectId, JSON.stringify(observation));
  }
  observations(projectId: number) { return this.rows<Observation>('observations', projectId).sort((a, b) => a.observedAt.localeCompare(b.observedAt)); }
  addBrief(brief: ProjectBrief) { this.write('briefs', brief.id, brief, brief.projectId); return brief; }
  briefs(projectId: number) { return this.rows<ProjectBrief>('briefs', projectId); }
  saveRun(run: Run) { this.write('runs', run.id, run); }
  runs(): Run[] { return this.rows<Run>('runs').sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30); }
}
