import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Analysis, DecisionInput, Evidence, ProjectDetail } from '../shared/contracts';
import { dimensionLabels, recommendationLabels, sceneLabels } from '../shared/contracts';
import { errorMessage, externalUrl, request } from './api';
import { MaterialEditor } from './MaterialEditor';
import { ProjectBriefPanel } from './ProjectBriefPanel';
import { EvidenceList } from './EvidenceList';

// test=决定实测，watch=继续观察，pass=暂不投入；仅明确保存后形成经营者判断。
const decisionLabels: Record<DecisionInput['action'], string> = { test: '决定实测', watch: '继续观察', pass: '暂不投入' };
// high/medium/low 为分维度判断；unknown 为证据不足，不归入低等级。
const levelLabels = { high: '高', medium: '中', low: '低', unknown: '证据不足' };
// conclusion=选题结论；evidence=来源材料；history=人工判断与历次分析记录。
type DetailTab = 'conclusion' | 'evidence' | 'brief' | 'materials' | 'history';
const tabs: { id: DetailTab; label: string }[] = [
  { id: 'conclusion', label: '选题结论' }, { id: 'brief', label: '中文资料' }, { id: 'materials', label: '素材编辑' }, { id: 'evidence', label: '证据来源' }, { id: 'history', label: '判断记录' },
];

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间不可用' : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

interface Props {
  detail: ProjectDetail;
  busy: boolean;
  canAnalyze: boolean;
  onAnalyze: () => void;
  onRefresh: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

export function ProjectPanel({ detail, busy, canAnalyze, onAnalyze, onRefresh, onDirtyChange }: Props) {
  const { project, evidence, analyses, decisions } = detail;
  const analysis = project.latestAnalysis;
  const [tab, setTab] = useState<DetailTab>('conclusion');
  const [focusedEvidence, setFocusedEvidence] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  const dirtyRef = useRef(false);
  const handleDirty = useCallback((dirty: boolean) => { dirtyRef.current = dirty; onDirtyChange?.(dirty); }, [onDirtyChange]);
  const switchTab = (next: DetailTab) => {
    if (next !== tab && dirtyRef.current && !window.confirm('有尚未保存的文案，确认放弃这些修改吗？')) return;
    if (next !== 'evidence') setFocusedEvidence(null);
    setTab(next);
  };
  const referencedIds = new Set(analysis ? [...analysis.evidenceIds, ...analysis.dimensions.flatMap(item => item.evidenceIds)] : []);
  const openEvidence = (id?: string) => { setFocusedEvidence(id ?? null); setTab('evidence'); };
  const tabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    switchTab(tabs[next]!.id);
    document.getElementById(`tab-${project.id}-${tabs[next]!.id}`)?.focus();
  };

  return <article className="project-reading">
    <header className="project-heading">
      <div className="project-title-row"><div><p className="project-owner">{project.fullName.split('/')[0]}</p><h1 ref={headingRef} tabIndex={-1}>{project.fullName.split('/').slice(1).join('/')}</h1></div><a className="external-link" href={externalUrl(project.url)} target="_blank" rel="noreferrer">GitHub ↗</a></div>
      <p className="project-description">{project.description || '项目未提供简介。'}</p>
      <div className="project-meta"><span>{sceneLabels[project.scene]}</span>{project.language && <span>{project.language}</span>}<span>{project.stars.toLocaleString()} Stars</span>{project.dailyStars !== null && <span>日榜 +{project.dailyStars.toLocaleString()}</span>}</div>
      <p className="snapshot-note">榜单采集于 {formatDate(project.lastSeenAt)} · <a href={externalUrl(project.sourceUrl)} target="_blank" rel="noreferrer">查看来源</a> · 日榜增量不代表已验证持续增长。</p>
    </header>

    {project.lastError && <div className="notice notice-error project-error" role="alert"><div><strong>上次处理未完成</strong><p>{project.lastError}</p>{analysis && <p>以下保留上一次成功分析，未覆盖历史结论。</p>}</div></div>}
    <div className="detail-tabs" role="tablist" aria-label="项目详情内容">{tabs.map((item, index) => <button key={item.id} id={`tab-${project.id}-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`panel-${project.id}-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => switchTab(item.id)} onKeyDown={event => tabKeyDown(event, index)}>{item.label}{item.id === 'evidence' && <span>{evidence.length}</span>}{item.id === 'history' && decisions.length > 0 && <span>{decisions.length}</span>}</button>)}</div>

    <section id={`panel-${project.id}-conclusion`} role="tabpanel" aria-labelledby={`tab-${project.id}-conclusion`} hidden={tab !== 'conclusion'} className="tab-content">
      <div className="analysis-toolbar"><p>{analysis ? `分析于 ${formatDate(analysis.createdAt)}` : '尚未生成选题结论'}</p><button className="button button-secondary" disabled={busy || !canAnalyze} onClick={onAnalyze}>{busy ? '正在处理…' : analysis ? '重新分析' : '分析这个项目'}</button></div>
      {analysis ? <><AnalysisCard analysis={analysis} evidence={evidence} onEvidence={openEvidence} /><div className="conclusion-actions"><button className="button button-primary" onClick={() => switchTab('history')}>记录我的判断</button><button className="text-button" onClick={() => openEvidence()}>查看证据来源</button></div></> : <div className="analysis-empty"><h2>待分析</h2><p>{canAnalyze ? '分析会核验中国用户需求与中文教程缺口，再给出是否值得实测的建议。' : '尚未生成中文分析，当前展示项目原始资料。配置分析模型与公开检索后，即可生成选题结论。'}</p>{!canAnalyze && <details className="configuration-help"><summary>如何配置分析服务</summary><p>按 <code>.env.example</code> 在本地 <code>.env</code> 中填写分析与检索配置，然后重启服务。密钥不需要在页面输入。</p></details>}<button className="text-button" onClick={() => openEvidence()}>查看已收集的 {evidence.length} 条材料 →</button></div>}
      {project.screeningReason && <details className="screening-details"><summary>初筛依据</summary><p>{project.screeningReason}</p><p className="section-note">这是初筛线索，实际需求与付费意愿仍需核验。</p></details>}
    </section>

    <section id={`panel-${project.id}-evidence`} role="tabpanel" aria-labelledby={`tab-${project.id}-evidence`} hidden={tab !== 'evidence'} className="tab-content">
      <div className="section-intro"><h2>证据来源</h2><p>保留每次采集的材料。展开查看内容与覆盖限制，引用标记对应当前分析。</p></div>
      <EvidenceList evidence={evidence} referencedIds={referencedIds} focusedId={focusedEvidence} />
      <ManualEvidenceForm projectId={project.id} onRefresh={onRefresh} />
    </section>

    <section id={`panel-${project.id}-brief`} role="tabpanel" aria-labelledby={`tab-${project.id}-brief`} hidden={tab !== 'brief'} className="tab-content">
      {tab === 'brief' && <ProjectBriefPanel key={project.id} projectId={project.id} canGenerate={canAnalyze && !busy} />}
    </section>

    <section id={`panel-${project.id}-materials`} role="tabpanel" aria-labelledby={`tab-${project.id}-materials`} hidden={tab !== 'materials'} className="tab-content">
      {tab === 'materials' && <MaterialEditor key={project.id} projectId={project.id} projectName={project.fullName} onDirtyChange={handleDirty} />}
    </section>

    <section id={`panel-${project.id}-history`} role="tabpanel" aria-labelledby={`tab-${project.id}-history`} hidden={tab !== 'history'} className="tab-content">
      {analysis ? <DecisionForm projectId={project.id} analysis={analysis} latestDecision={project.latestDecision} onRefresh={onRefresh} /> : <div className="small-empty"><h2>还没有可记录的分析</h2><p>生成选题结论后，可以保存你的判断与理由。</p></div>}
      <div className="history-section"><h2>判断记录</h2>{decisions.length ? <ol className="history-list">{decisions.map(item => <li key={item.id}><div><strong>{decisionLabels[item.action]}</strong><time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time></div><p>{item.reason}</p><details><summary>对应分析版本</summary><code>{item.analysisId}</code></details></li>)}</ol> : <p className="section-note">尚未保存判断。AI 建议不会自动成为你的决定。</p>}</div>
      {analyses.length > 0 && <details className="analysis-history"><summary>历次分析 <span>{analyses.length}</span></summary><ol className="history-list">{analyses.map(item => <li key={item.id}><div><strong>{recommendationLabels[item.recommendation]}</strong><time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time></div><p>{item.summary}</p><span className="section-note">{item.provider} / {item.model}</span></li>)}</ol></details>}
    </section>
  </article>;
}

function AnalysisCard({ analysis, evidence, onEvidence }: { analysis: Analysis; evidence: Evidence[]; onEvidence: (id?: string) => void }) {
  const questions = [
    { title: '谁需要它', text: analysis.audience },
    { title: '中文内容缺什么', text: analysis.contentGap },
    { title: '可以做什么内容或服务', text: analysis.deliverable },
    { title: '为什么现在关注', text: analysis.whyNow },
    { title: '下一步先验证什么', text: analysis.nextStep },
  ];
  return <div className="analysis-content">
    <section className={`verdict verdict-${analysis.recommendation}`}><p>选题建议</p><h2>{recommendationLabels[analysis.recommendation]}</h2><p className="verdict-summary">{analysis.summary}</p></section>
    <div className="decision-questions">{questions.map(question => <section key={question.title}><h3>{question.title}</h3><p>{question.text}</p></section>)}</div>
    <div className="analysis-caveats"><section><h3>为什么可能不值得做</h3><ul>{analysis.counterEvidence.map((text, index) => <li key={index}>{text}</li>)}</ul></section><section><h3>仍需核验</h3><ul>{analysis.unknowns.map((text, index) => <li key={index}>{text}</li>)}</ul></section><section><h3>投入与支持负担</h3><p>{analysis.costs}</p></section></div>
    <details className="dimension-section"><summary>八项分析维度<span>分项判断，不合成总分</span></summary><div className="dimension-grid">{analysis.dimensions.map(item => <section key={item.key}><div><h3>{dimensionLabels[item.key]}</h3><span className={`level level-${item.level}`}>{levelLabels[item.level]}</span></div><p>{item.reason}</p>{item.evidenceIds.length > 0 && <div className="inline-evidence">{item.evidenceIds.map(id => { const source = evidence.find(entry => entry.id === id); return source ? <button className="text-button" key={id} onClick={() => onEvidence(id)}>{source.title} ↗</button> : <span key={id}>来源已不可用</span>; })}</div>}</section>)}</div></details>
    <details className="conditions-section"><summary>什么情况会改变建议</summary><ul>{analysis.changeConditions.map((text, index) => <li key={index}>{text}</li>)}</ul></details>
    <details className="analysis-method"><summary>分析信息与能力范围</summary><p>{analysis.provider} / {analysis.model} · 规则 {analysis.ruleVersion}</p><p>当前版本尚未启用 7 天预测，选题建议依据已有证据。</p><p>本次总体建议引用 {analysis.evidenceIds.length} 条材料，引用可在“证据来源”中查看。</p></details>
  </div>;
}

function DecisionForm({ projectId, analysis, latestDecision, onRefresh }: { projectId: number; analysis: Analysis; latestDecision: ProjectDetail['project']['latestDecision']; onRefresh: () => Promise<void> }) {
  const [action, setAction] = useState<DecisionInput['action']>(latestDecision?.action ?? 'watch');
  const [reason, setReason] = useState(latestDecision?.reason ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setSaved(false);
    try {
      await request(`/api/projects/${projectId}/decisions`, { method: 'POST', body: JSON.stringify({ analysisId: analysis.id, action, reason: reason.trim() }) });
      setSaved(true);
      try { await onRefresh(); }
      catch (cause) { setError(`判断已保存，但页面刷新失败：${errorMessage(cause)}`); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  };
  return <section className="decision-form-section"><p className="eyebrow">由你决定</p><h3>这个选题，值得投入吗？</h3><p className="section-note">记录你的判断与理由，AI 重分析不会替你修改决定。</p><form onSubmit={event => void save(event)}><fieldset disabled={saving}><legend className="visually-hidden">选择你的决定</legend><div className="decision-options">{(Object.keys(decisionLabels) as DecisionInput['action'][]).map(value => <label key={value} className={action === value ? 'chosen' : ''}><input type="radio" name={`decision-${projectId}`} value={value} checked={action === value} onChange={() => { setAction(value); setSaved(false); }} />{decisionLabels[value]}</label>)}</div><label className="field-label" htmlFor={`reason-${projectId}`}>判断理由</label><textarea id={`reason-${projectId}`} value={reason} maxLength={3000} required rows={3} placeholder="例如：用户需求明确，先验证普通电脑是否能完成安装。" onChange={event => { setReason(event.target.value); setSaved(false); }} /><div className="form-footer"><span>{saved ? <span className="saved-message" role="status">判断已保存</span> : latestDecision ? `上次记录于 ${formatDate(latestDecision.createdAt)}` : '仅保存你的判断，不会自动安装或发布。'}</span><button className="button button-primary" disabled={saving || !reason.trim()}>{saving ? '正在保存…' : '保存我的判断'}</button></div></fieldset>{error && <p className="form-error" role="alert">{error}</p>}</form></section>;
}

function ManualEvidenceForm({ projectId, onRefresh }: { projectId: number; onRefresh: () => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setSaved(false);
    try {
      await request(`/api/projects/${projectId}/evidence`, { method: 'POST', body: JSON.stringify({ title: title.trim(), url: url.trim(), excerpt: excerpt.trim() }) });
      setTitle(''); setUrl(''); setExcerpt(''); setSaved(true);
      try { await onRefresh(); }
      catch (cause) { setError(`材料已保存，但页面刷新失败：${errorMessage(cause)}`); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  };
  return <details className="manual-evidence"><summary>＋ 补充我找到的材料</summary><p className="section-note">补充教程、讨论或求助摘录。材料会标为人工提供；重新分析后才会纳入新建议。</p><form onSubmit={event => void save(event)}><fieldset disabled={saving}><label className="field-label" htmlFor={`evidence-title-${projectId}`}>材料标题</label><input id={`evidence-title-${projectId}`} required maxLength={200} value={title} onChange={event => { setTitle(event.target.value); setSaved(false); }} /><label className="field-label" htmlFor={`evidence-url-${projectId}`}>来源链接</label><input id={`evidence-url-${projectId}`} type="url" required value={url} onChange={event => { setUrl(event.target.value); setSaved(false); }} placeholder="https://" /><label className="field-label" htmlFor={`evidence-excerpt-${projectId}`}>相关摘录</label><textarea id={`evidence-excerpt-${projectId}`} required maxLength={10000} rows={4} value={excerpt} onChange={event => { setExcerpt(event.target.value); setSaved(false); }} /><div className="form-footer"><span>{saved && <span className="saved-message" role="status">材料已保存，可重新分析</span>}</span><button className="button button-secondary" disabled={saving || !title.trim() || !url.trim() || !excerpt.trim()}>{saving ? '正在保存…' : '保存材料'}</button></div></fieldset>{error && <p className="form-error" role="alert">{error}</p>}</form></details>;
}
