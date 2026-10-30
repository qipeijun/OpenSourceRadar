import { useEffect, useRef, useState } from 'react';
import type { MaterialVersion } from '../shared/contracts';
import { errorMessage, request } from './api';
import { ImagePanel } from './ImagePanel';

// titles 仅修改标题，body 仅修改正文，all 修改整份文案。
type RevisionScope = 'titles' | 'body' | 'all';
const platformLabels = { xiaohongshu: '小红书', xianyu: '闲鱼' };
const kindLabels = { generated: '生成', manual: '人工编辑', revised: '补充要求修改', restored: '恢复旧版' };

export function MaterialEditor({ projectId, projectName, onDirtyChange }: { projectId: number; projectName: string; onDirtyChange: (dirty: boolean) => void }) {
  const [versions, setVersions] = useState<MaterialVersion[]>([]);
  const [platform, setPlatform] = useState<MaterialVersion['platform']>('xiaohongshu');
  const [selectedId, setSelectedId] = useState('');
  const [titles, setTitles] = useState('');
  const [body, setBody] = useState('');
  const [instruction, setInstruction] = useState('');
  const [scope, setScope] = useState<RevisionScope>('body');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  // 每版已配图数量与“文案更新后是否同步重做配图”的询问，配图只在经营者明确同意后再生成。
  const [imageCounts, setImageCounts] = useState<Record<string, number>>({});
  const [syncPrompt, setSyncPrompt] = useState<{ fromId: string; count: number } | null>(null);
  const [startSignal, setStartSignal] = useState(0);
  const lock = useRef(false);
  const selected = versions.find(item => item.id === selectedId);
  const currentVersions = versions.filter(item => item.platform === platform);
  const dirty = !!selected && (titles !== selected.titles.join('\n') || body !== selected.body);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  function select(version?: MaterialVersion) {
    setSelectedId(version?.id ?? ''); setTitles(version?.titles.join('\n') ?? ''); setBody(version?.body ?? ''); setMessage('');
  }
  useEffect(() => {
    const controller = new AbortController();
    void request<{ versions: MaterialVersion[]; imageCounts: Record<string, number> }>(`/api/projects/${projectId}/materials`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setVersions(result.versions); setImageCounts(result.imageCounts ?? {}); select(result.versions.find(item => item.platform === 'xiaohongshu')); }
    }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId]);
  function mayDiscard() { return !dirty || window.confirm('有尚未保存的文案，确认放弃这些修改吗？'); }
  async function action(payload: object) {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(''); setMessage('');
    try {
      const version = await request<MaterialVersion>(`/api/projects/${projectId}/materials`, { method: 'POST', body: JSON.stringify(payload) });
      setVersions(items => [version, ...items]); select(version); setMessage('已保存为新版本');
      const baseId = (payload as { baseVersionId?: string }).baseVersionId;
      // 只在旧版本确实已有配图、且新版本尚未配图时询问，不自动重做图片。
      if (baseId && imageCounts[baseId]) setSyncPrompt({ fromId: baseId, count: imageCounts[baseId] });
      setImageCounts(counts => ({ ...counts, [version.id]: 0 }));
    } catch (cause) { setError(errorMessage(cause)); }
    finally { lock.current = false; setPending(false); }
  }
  const cleanTitles = titles.split('\n').map(title => title.trim()).filter(Boolean);
  async function copy() {
    setError('');
    try { await navigator.clipboard.writeText(`${cleanTitles[0] ?? ''}\n\n${body}`); setMessage(dirty ? '已复制当前编辑内容，尚未保存' : '已复制文案'); }
    catch { setError('复制失败，请选中文案后手动复制'); }
  }
  return <section className="material-editor" aria-label="素材编辑">
    <div className="editor-heading"><div><h2>素材编辑</h2><p>{projectName} · {platformLabels[platform]} · {selected ? `版本 ${selected.id.slice(0, 8)}（${kindLabels[selected.kind]}）` : '尚无文案'}</p></div><span role="status">{pending ? `正在处理 ${projectName} 的${platformLabels[platform]}文案…` : dirty ? '尚未保存' : selected ? '已保存' : '草稿'}</span></div>
    <p className="section-note">素材保持草稿，平台适用规则尚未核验；不会自动发布。</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {message && <p role="status">{message}</p>}
    <fieldset disabled={pending || loading}>
      <label className="field-label">平台<select aria-label="素材平台" value={platform} onChange={event => { if (mayDiscard()) { const next = event.target.value as MaterialVersion['platform']; setPlatform(next); select(versions.find(item => item.platform === next)); } }}>{Object.entries(platformLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {currentVersions.length > 0 && <label className="field-label">历史版本<select aria-label="素材版本" value={selectedId} onChange={event => { if (mayDiscard()) select(versions.find(item => item.id === event.target.value)); }}>{currentVersions.map((version, index) => <option key={version.id} value={version.id}>{index === 0 ? '最新 · ' : ''}{kindLabels[version.kind]} · {new Date(version.createdAt).toLocaleString('zh-CN')}</option>)}</select></label>}
      <label className="field-label" htmlFor={`instruction-${projectId}`}>补充要求</label><textarea id={`instruction-${projectId}`} rows={2} maxLength={4000} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="例如：面向老师介绍，正文再口语化一点" />
      <button className="button button-primary" onClick={() => { if (mayDiscard()) void action({ action: 'generate', platform, instruction }); }}>{selected ? '重新生成文案' : '生成文案'}</button>
      {selected && <>
        <label className="field-label" htmlFor={`titles-${projectId}`}>标题备选（每行一个，第一行为当前标题）</label><textarea id={`titles-${projectId}`} rows={3} value={titles} onChange={event => { setTitles(event.target.value); setMessage(''); }} />
        <label className="field-label" htmlFor={`body-${projectId}`}>正文</label><textarea id={`body-${projectId}`} rows={8} maxLength={2000} value={body} onChange={event => { setBody(event.target.value); setMessage(''); }} />
        <div className="editor-actions"><button className="button button-primary" disabled={!dirty || !cleanTitles.length || cleanTitles.length > 5 || !body.trim()} onClick={() => void action({ action: 'manual', baseVersionId: selected.id, titles: cleanTitles, body })}>保存文案</button><button className="button button-secondary" onClick={() => void copy()}>复制文案</button>{!dirty && <a className="button button-secondary" href={`/api/projects/${projectId}/materials/${selected.id}/text`} download>下载文案</a>}{!dirty && <a className="button button-secondary" href={`/api/projects/${projectId}/export?version=${selected.id}`} download>打包导出这一套</a>}</div>
        <label className="field-label">修改范围<select aria-label="修改范围" value={scope} onChange={event => setScope(event.target.value as RevisionScope)}><option value="titles">只改标题</option><option value="body">只改正文</option><option value="all">整份文案</option></select></label>
        {dirty && <p className="section-note">先保存人工编辑，再按补充要求修改，避免丢失当前内容。</p>}
        <button className="button button-secondary" disabled={dirty || !instruction.trim()} onClick={() => void action({ action: 'revise', baseVersionId: selected.id, scope, instruction })}>按要求修改文案</button>
        {currentVersions[0]?.id !== selected.id && <button className="button button-secondary" onClick={() => { if (mayDiscard()) void action({ action: 'restore', baseVersionId: currentVersions[0]!.id, restoreVersionId: selected.id }); }}>恢复这个版本</button>}
      </>}
    </fieldset>
    {selected && syncPrompt && <div className="notice notice-sync" role="status">
      <span>{`这一版文案已更新，上一版有 ${syncPrompt.count} 张配图仍是旧内容。要不要为这一版重新生成配图？旧版配图会保留。`}</span>
      <button className="button button-secondary" onClick={() => { setStartSignal(value => value + 1); setSyncPrompt(null); }}>现在生成配图</button>
      <button className="text-button" onClick={() => setSyncPrompt(null)}>暂不更新</button>
    </div>}
    {selected && <ImagePanel key={`${projectId}-${platform}`} projectId={projectId} materialVersionId={selected.id} platformName={platformLabels[platform]} startSignal={startSignal} onSettled={count => { setImageCounts(counts => ({ ...counts, [selected.id]: count })); if (count > 0) setSyncPrompt(null); }} />}
    {selected && dirty && <p className="section-note">上面有未保存的文案改动，配图仍对应已保存的版本；请先保存文案再配图。</p>}
    {loading && <p>正在读取素材版本…</p>}
  </section>;
}
