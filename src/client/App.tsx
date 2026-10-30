import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, ProjectDetail, ProjectsResponse, Run, StatusResponse } from '../shared/contracts';
import { recommendationLabels, sceneLabels } from '../shared/contracts';
import { errorMessage, request } from './api';
import { ServiceSettings } from './ServiceSettings';
import { ProjectPanel, formatDate } from './ProjectPanel';

// all=全部候选；analyzed=已有分析；unreviewed=已有分析但尚无人工判断。
type ListFilter = 'all' | 'analyzed' | 'unreviewed';
const filterLabels: Record<ListFilter, string> = { all: '全部候选', analyzed: '已有分析', unreviewed: '待我判断' };
// 仅等待和执行中的任务需要轮询；结束后停止。
const activeStatuses = new Set<Run['status']>(['queued', 'running']);
const runLabels: Record<Run['status'], string> = {
  queued: '等待执行', running: '正在处理', succeeded: '运行完成', partial: '部分完成', failed: '运行失败',
};

export default function App() {
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  // null 表示候选列表；只有用户主动选择才进入详情，刷新不会自动打开第一项。
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [filter, setFilter] = useState<ListFilter>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [requestPending, setRequestPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const returnFocusId = useRef<number | null>(null);
  const running = !!status?.activeRun && activeStatuses.has(status.activeRun.status);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [nextStatus, nextProjects] = await Promise.all([
      request<StatusResponse>('/api/status', { signal }),
      request<ProjectsResponse>('/api/projects', { signal }),
    ]);
    if (signal?.aborted) return;
    setStatus(nextStatus);
    setProjects(nextProjects.projects);
    setSelectedId(current => nextProjects.projects.some(project => project.id === current) ? current : null);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(cause => {
      if (!controller.signal.aborted) { setError(errorMessage(cause)); setLoading(false); }
    });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // 请求结束后才安排下一次轮询，避免慢服务造成重叠。
    const poll = async () => {
      try { await refresh(controller.signal); }
      catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [running, refresh]);

  const selectedProject = projects.find(project => project.id === selectedId);
  useEffect(() => {
    setDetailError(null);
    if (selectedId === null) { setDetail(null); return; }
    const controller = new AbortController();
    void request<ProjectDetail>(`/api/projects/${selectedId}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setDetail(result); })
      .catch(cause => { if (!controller.signal.aborted) setDetailError(errorMessage(cause)); });
    // 返回列表或切换项目时取消旧请求，旧响应不得重新打开或覆盖页面。
    return () => controller.abort();
  }, [selectedId, revision, selectedProject?.latestAnalysis?.id, selectedProject?.latestDecision?.id, selectedProject?.lastSeenAt, selectedProject?.lastError]);

  const refreshDetail = async () => { await refresh(); setRevision(current => current + 1); };
  const startRun = async (path: string) => {
    setRequestPending(true); setError(null);
    try {
      const run = await request<Run>(path, { method: 'POST', body: '{}' });
      setStatus(current => current ? { ...current, activeRun: run, latestRun: run } : current);
      await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setRequestPending(false); }
  };
  const filtered = projects.filter(project => {
    if (filter === 'analyzed' && !project.latestAnalysis) return false;
    if (filter === 'unreviewed' && (!project.latestAnalysis || project.latestDecision)) return false;
    return `${project.fullName} ${project.description} ${project.latestAnalysis?.summary ?? ''}`.toLowerCase().includes(query.trim().toLowerCase());
  }).sort((a, b) => (b.dailyStars ?? -1) - (a.dailyStars ?? -1) || a.fullName.localeCompare(b.fullName));
  const selectedDetail = detail?.project.id === selectedId ? detail : null;
  const canAnalyze = !!status?.analysisConfigured && !!status?.searchConfigured;
  const busy = running || requestPending;
  const returnToList = () => { if ((editorDirty || settingsDirty) && !window.confirm('有尚未保存的文案，确认放弃这些修改吗？')) return; setEditorDirty(false); setShowSettings(false); returnFocusId.current = selectedId; setSelectedId(null); };
  useEffect(() => {
    if (selectedId === null && returnFocusId.current !== null) {
      document.getElementById(`candidate-${returnFocusId.current}`)?.focus();
      returnFocusId.current = null;
    }
  }, [selectedId]);

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={returnToList} aria-label="OpenSourceRadar，返回候选列表"><span className="brand-mark" aria-hidden="true">◎</span>OpenSource<span>Radar</span></button>
      <button onClick={() => { if (showSettings && settingsDirty && !window.confirm('服务信息尚未保存，确认放弃这些修改吗？')) return; setShowSettings(value => !value); }} aria-expanded={showSettings}>设置</button>
      <span className="local-label">本地工作台</span>
    </header>
    <main id="main">
      {showSettings && <ServiceSettings onChanged={refresh} onDirtyChange={setSettingsDirty} />}
      <div hidden={showSettings}>
      {error && <div className="notice notice-error" role="alert"><span>{error}</span><button className="text-button" onClick={() => void refresh().catch(cause => setError(errorMessage(cause)))}>重新连接</button></div>}
      {selectedId === null ? <>
        <section className="page-heading">
          <div><h1>候选项目</h1><p>从开源趋势中，寻找值得制作中文教程的工具。</p></div>
          <button className="button button-primary" disabled={busy || loading} onClick={() => void startRun('/api/discover')}>{busy ? '正在处理…' : '发现新项目'}</button>
        </section>
        {status && <SystemStatus status={status} running={running} />}
        <section className="candidate-workspace" aria-label="候选项目列表">
          <div className="list-controls">
            <div className="list-filters" aria-label="候选筛选">{(Object.keys(filterLabels) as ListFilter[]).map(value => <button key={value} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{filterLabels[value]}</button>)}</div>
            <input className="search-input" aria-label="搜索候选项目" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索项目或用途" />
          </div>
          <div className="list-context"><p>{filtered.length} 个候选 · {status?.analyzedCount ?? 0} 个已有分析<span>按日榜增量排序，非推荐排名</span></p>{projects.length > 0 && <button className="text-button" disabled={busy || !canAnalyze} onClick={() => void startRun('/api/analyze')}>分析候选</button>}</div>
          {loading ? <div className="empty-state" role="status">正在读取候选项目…</div> : filtered.length === 0 ? <div className="empty-state"><h2>{projects.length ? '没有符合筛选的项目' : '还没有候选项目'}</h2><p>{projects.length ? '换一个关键词，或查看全部候选。' : '点击“发现新项目”，系统会从趋势榜收集真实候选，无需提供链接。'}</p></div> : <table className="candidate-table"><caption className="visually-hidden">自动发现的开源项目，按采集时的日榜增量排序</caption><thead><tr><th scope="col">项目</th><th scope="col">用途摘要</th><th scope="col">场景</th><th scope="col">日榜增量</th><th scope="col">分析状态</th></tr></thead><tbody>{filtered.map(project => <tr key={project.id}>
            <td className="project-cell"><button id={`candidate-${project.id}`} className="project-link" onClick={() => setSelectedId(project.id)}><strong>{project.fullName.split('/').slice(1).join('/')}</strong><span>{project.fullName.split('/')[0]}</span></button></td>
            <td className="description-cell"><p>{project.latestAnalysis?.summary || project.description || '项目未提供简介'}</p></td>
            <td className="scene-cell" data-label="场景"><span>{sceneLabels[project.scene]}</span></td>
            <td className="growth-cell" data-label="日榜增量"><strong>{project.dailyStars === null ? '未提供' : `+${project.dailyStars.toLocaleString()}`}</strong><time dateTime={project.lastSeenAt} title={`榜单数据采集于 ${project.lastSeenAt}`}>{formatDate(project.lastSeenAt)}</time></td>
            <td className="analysis-cell" data-label="分析状态"><span className={project.latestAnalysis ? 'analysis-label ready' : 'analysis-label'}>{project.latestAnalysis ? recommendationLabels[project.latestAnalysis.recommendation] : '待分析'}</span>{project.lastError && <span className="row-warning">上次处理失败</span>}{project.latestDecision && <span className="secondary-label">已记录判断</span>}</td>
          </tr>)}</tbody></table>}
          <p className="list-footnote">日榜增量为采集时的榜单快照，不代表已验证持续增长。点击项目查看结论与证据。</p>
        </section>
      </> : <div className="reading-page">
        <button className="back-button" onClick={returnToList}>← 返回候选列表</button>
        {running && status?.activeRun && <p className="detail-run-progress" role="status">{status.activeRun.stage} · 已处理 {status.activeRun.completed} / {status.activeRun.total}</p>}
        {detailError && <div className="notice notice-error" role="alert"><span>{detailError}</span><button className="text-button" onClick={() => setRevision(current => current + 1)}>重试详情</button></div>}
        {selectedDetail ? <ProjectPanel key={selectedDetail.project.id} detail={selectedDetail} busy={busy} canAnalyze={canAnalyze} onAnalyze={() => void startRun(`/api/projects/${selectedDetail.project.id}/analyze`)} onRefresh={refreshDetail} onDirtyChange={setEditorDirty} /> : !detailError && <div className="empty-state" role="status">正在读取项目详情…</div>}
      </div>}
      </div>
    </main>
    <footer className="page-footer">OpenSourceRadar · 先核验证据，再决定是否投入。</footer>
  </div>;
}

function SystemStatus({ status, running }: { status: StatusResponse; running: boolean }) {
  const run = status.activeRun ?? status.latestRun;
  const configured = status.analysisConfigured && status.searchConfigured;
  const failed = run?.status === 'failed' || run?.status === 'partial';
  return <section className="system-status" aria-label="服务与运行状态">
    <details>
      <summary><span className={`status-dot ${configured ? '' : 'warning'}`} /><span>{configured ? '分析服务已配置' : 'AI 分析待配置'}</span><span className="status-divider">·</span><span>{run ? `${runLabels[run.status]}${running ? ` ${run.completed}/${run.total}` : ''}` : '尚未运行发现'}</span><span className="status-action">配置与运行详情</span></summary>
      <div className="status-details">
        <dl><div><dt>分析模型</dt><dd>{status.analysisConfigured ? status.analysisModel : '未配置'}</dd></div><div><dt>公开检索</dt><dd>{status.searchConfigured ? status.searchModel : '未配置'}</dd></div>{run && <><div><dt>最近运行</dt><dd>{formatDate(run.startedAt)} · 已处理 {run.completed} / {run.total}</dd></div><div><dt>当前阶段</dt><dd>{run.stage}</dd></div></>}</dl>
        {!configured && <p>可以先发现项目。按 <code>.env.example</code> 在本地 <code>.env</code> 中填写分析与检索配置后重启服务；密钥不在页面输入。</p>}
        {run && run.errors.length > 0 && <div className="run-errors"><strong>运行问题</strong><ul>{run.errors.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}
      </div>
    </details>
    {!configured && <p className="status-note">尚未生成中文分析，当前展示项目原始资料。</p>}
    {running && <p className="running-summary" role="status">{run?.stage} · {run?.completed} / {run?.total}</p>}
    {failed && <p className="run-failure" role="alert">{runLabels[run.status]}：{run.errors[0] || run.stage}{run.errors.length > 1 ? `（另有 ${run.errors.length - 1} 项问题，可展开查看）` : ''}</p>}
  </section>;
}
