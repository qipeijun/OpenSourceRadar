import { OperationGate } from './operation.js';
import { randomUUID } from 'node:crypto';
import type { Project, Run } from '../shared/contracts.js';
import { isConfigured, type Config } from './config.js';
import { discover, getReadme, getRepository } from './github.js';
import { analyze, searchEvidence } from './ai.js';
import { Store } from './store.js';
import type { Fetch } from './http.js';

/** 已分析项目不自动重复付费分析；批次留出一个场景未知项目以避免只关注成熟热门工具。 */
export function selectBatch(projects: Project[], size: number): Project[] {
  // 用榜单增量排序，不用逐仓库请求产生的毫秒时间差决定分析名额。
  const fresh = projects.filter(p => !p.latestAnalysis)
    .sort((a, b) => (b.dailyStars ?? -1) - (a.dailyStars ?? -1) || a.id - b.id);
  const known = fresh.filter(p => p.scene !== 'unknown');
  const exploration = fresh.filter(p => p.scene === 'unknown');
  const selected = known.slice(0, exploration.length && size > 1 ? size - 1 : size);
  return [...selected, ...exploration.slice(0, size - selected.length)];
}

export class RadarService {
  private gate = new OperationGate();
  private active: Run | null = null;
  private work: Promise<void> | null = null;
  private controller = new AbortController();
  private stopping = false;
  private fetcher: Fetch;
  constructor(readonly store: Store, readonly config: Config, fetcher: Fetch = globalThis.fetch) {
    this.fetcher = (input, init) => fetcher(input, { ...init, signal: AbortSignal.any([this.controller.signal, ...(init?.signal ? [init.signal] : [])]) });
  }
  selectedProvider(): 'gpt' | 'deepseek' { return this.store.analysisProvider() ?? (this.config.analysis.wire === 'responses' ? 'gpt' : 'deepseek'); }
  analysisConfig() { return this.config.providers?.[this.selectedProvider()] ?? this.config.analysis; }
  searchConfig() { return this.store.searchProvider() === 'gpt' && this.config.providers ? this.config.providers.gpt : this.config.search; }
  activeRun() { return this.active; }
  async waitForIdle() { await this.work; }
  /** 关闭服务时中止当前网络请求并停止后续项目，避免退出后继续付费调用。 */
  stop() { this.stopping = true; this.controller.abort(); }
  private checkRunning() { if (this.stopping) throw new Error('本地服务正在关闭，任务已中断'); }
  start(kind: Run['kind'], projectId: number | null = null): Run {
    this.checkRunning();
    if (this.active) throw new Error('已有任务正在运行，请等待完成');
    if (kind === 'analyze' && (!isConfigured(this.analysisConfig()) || !isConfigured(this.searchConfig()))) throw new Error('请先在本地配置 AI 分析和公开检索服务的密钥与模型');
    const run: Run = { id: randomUUID(), kind, projectId, status: 'queued', stage: '等待执行', startedAt: new Date().toISOString(), finishedAt: null, total: 0, completed: 0, errors: [] };
    this.active = run; this.store.saveRun(run);
    // 延后到响应发出后执行，调用方可以立即拿到任务 ID 并查看进度。
    const analysisConfig = { ...this.analysisConfig() };
    const searchConfig = { ...this.searchConfig() };
    this.work = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute(run, analysisConfig, searchConfig));
    // 持久化本身失败时仍保留可诊断日志；waitForIdle 继续向测试及关闭流程传播错误。
    void this.work.catch(error => { console.error('任务状态持久化失败：', errorMessage(error)); });
    return { ...run };
  }
  private update(run: Run, patch: Partial<Run>) { Object.assign(run, patch); this.store.saveRun(run); }
  private async execute(run: Run, analysisConfig: Config['analysis'], searchConfig: Config['search']) {
    let succeeded = 0;
    try {
      this.update(run, { status: 'running', stage: run.kind === 'discover' ? '获取 GitHub Trending' : '准备分析' });
      let projects: Project[];
      if (run.kind === 'discover') {
        this.checkRunning();
        const entries = await discover(this.fetcher);
        this.update(run, { total: entries.length, stage: '保存真实候选与来源' });
        const ids = new Set<number>();
        for (const entry of entries) {
          this.checkRunning();
          try {
            const { seed, evidence } = await getRepository(this.fetcher, entry, this.config.githubToken);
            this.checkRunning();
            const project = this.store.upsertProject(seed); this.store.addEvidence(evidence); ids.add(project.id); succeeded++;
          } catch (error) { this.checkRunning(); run.errors.push(`${entry.fullName}：${errorMessage(error)}`); }
          this.update(run, { completed: run.completed + 1 });
        }
        projects = this.store.projects().filter(p => ids.has(p.id));
        if (!isConfigured(this.analysisConfig()) || !isConfigured(this.searchConfig())) {
          this.update(run, { stage: '候选发现完成；配置 AI 与检索服务后可继续分析' });
          return;
        }
      } else {
        projects = run.projectId ? [this.store.project(run.projectId)].filter((p): p is Project => p !== null) : this.store.projects();
      }
      const batch = run.projectId ? projects : selectBatch(projects, this.config.batchSize);
      this.update(run, { total: run.total + batch.length, stage: batch.length ? '收集项目材料与中文证据' : '没有待分析的候选项目' });
      const searchPath = `search:${searchConfig.baseUrl}:${searchConfig.model}`;
      const analysisPath = `analysis:${analysisConfig.baseUrl}:${analysisConfig.model}`;
      for (const project of batch) {
        if (this.gate.stopped(searchPath) || this.gate.stopped(analysisPath)) { run.errors.push(this.gate.stoppedReason(this.gate.stopped(searchPath) ? searchPath : analysisPath)); break; }
        this.checkRunning();
        // 记录本候选实际失败的阶段，供设置页区分“已配置”和“真实调用过且成功”。
        let stage: 'search' | 'analysis' = 'search';
        try {
          this.update(run, { stage: `${project.fullName} · 获取 README` });
          const readme = await getReadme(this.fetcher, project.id, project.fullName, this.config.githubToken);
          this.checkRunning();
          this.store.addEvidence(readme);
          this.update(run, { stage: `${project.fullName} · 检索中文需求与教程` });
          const search = await this.gate.run(searchPath, () => searchEvidence(this.fetcher, searchConfig, project));
          this.checkRunning();
          this.store.recordCapability('search', { status: 'succeeded', at: new Date().toISOString(), provider: new URL(searchConfig.baseUrl).hostname, model: searchConfig.model });
          search.evidence.forEach(evidence => this.store.addEvidence(evidence));
          // 本次检索与最新官方材料加人工补充，避免把历次相互矛盾的摘要混成当前事实。
          const saved = this.store.evidence(project.id);
          const metadata = saved.find(item => item.source === 'repository' && item.title === 'GitHub 仓库信息');
          const evidence = [readme, ...(metadata ? [metadata] : []), ...search.evidence, ...saved.filter(item => item.source === 'manual')];
          this.update(run, { stage: `${project.fullName} · 生成选题决策卡` });
          stage = 'analysis';
          const result = await this.gate.run(analysisPath, () => analyze(this.fetcher, analysisConfig, project, evidence, { usage: search.usage, queries: search.queries, outcome: search.outcome }));
          this.checkRunning(); this.store.addAnalysis(result);
          this.store.recordCapability('analysis', { status: 'succeeded', at: new Date().toISOString(), provider: new URL(analysisConfig.baseUrl).hostname, model: analysisConfig.model });
          succeeded++;
        } catch (error) {
          this.checkRunning();
          const message = errorMessage(error); this.store.setProjectError(project.id, message); run.errors.push(`${project.fullName}：${message}`);
          const failedConfig = stage === 'search' ? searchConfig : analysisConfig;
          this.store.recordCapability(stage, { status: 'failed', at: new Date().toISOString(), provider: new URL(failedConfig.baseUrl).hostname, model: failedConfig.model, error: message });
        }
        this.update(run, { completed: run.completed + 1 });
      }
      this.update(run, { stage: run.errors.length ? '运行结束，部分项目需要处理' : '运行完成' });
    } catch (error) {
      run.errors.push(this.stopping ? '本地服务正在关闭，任务已中断' : errorMessage(error)); this.update(run, { status: 'failed', stage: this.stopping ? '运行已中断' : '运行失败' });
    } finally {
      try {
        const allFailed = run.errors.length > 0 && succeeded === 0;
        this.update(run, {
          status: run.status === 'failed' || allFailed ? 'failed' : run.errors.length ? 'partial' : 'succeeded',
          stage: allFailed && !this.stopping ? '运行失败，未成功完成任何项目处理' : run.stage,
          finishedAt: new Date().toISOString(),
        });
      } finally { this.active = null; }
    }
  }
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : '未知运行错误，请检查本地服务'; }
