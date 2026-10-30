import { useEffect, useState } from 'react';
import type { ProjectBrief } from '../shared/contracts';
import { errorMessage, request } from './api';

const certaintyLabels = { fact: '材料明确说明', inference: '根据材料推断', unknown: '未知' };
const sections = [{ key: 'purpose', title: '中文用途' }, { key: 'environment', title: '环境清单' }, { key: 'dependencies', title: '所需依赖' }, { key: 'limitations', title: '限制与条件' }] as const;

export function ProjectBriefPanel({ projectId, canGenerate }: { projectId: number; canGenerate: boolean }) {
  const [briefs, setBriefs] = useState<ProjectBrief[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void request<{ briefs: ProjectBrief[] }>(`/api/projects/${projectId}/briefs`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setBriefs(result.briefs); setSelected(result.briefs[0]?.id ?? ''); } }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId]);
  const current = briefs.find(item => item.id === selected);
  async function generate() {
    setPending(true); setError('');
    try {
      const brief = await request<ProjectBrief>(`/api/projects/${projectId}/briefs`, { method: 'POST', body: '{}' });
      setBriefs(items => [brief, ...items]); setSelected(brief.id);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  return <section aria-label="内部中文资料">
    <h2>中文资料与环境清单</h2>
    <p className="section-note">仅供内部选题和交付判断。来源为项目材料，不代表已实际部署验证。</p>
    <button className="button button-primary" disabled={!canGenerate || pending || loading} onClick={() => void generate()}>{pending ? '正在整理这个项目的资料…' : '生成中文资料'}</button>
    {error && <p role="alert">{error}</p>}
    {briefs.length > 0 && <label>资料版本 <select value={selected} onChange={event => setSelected(event.target.value)}>{briefs.map((brief, index) => <option key={brief.id} value={brief.id}>{index === 0 ? '最新 · ' : ''}{new Date(brief.createdAt).toLocaleString('zh-CN')}</option>)}</select></label>}
    {current ? <>
      {sections.map(section => <section key={section.key}><h3>{section.title}</h3><ul>{current[section.key].map((item, index) => <li key={index}><strong>{certaintyLabels[item.certainty]}：</strong>{item.text}{item.evidenceIds.length > 0 && <details><summary>来源标识</summary>{item.evidenceIds.join('、')}（可在证据来源中核对）</details>}</li>)}</ul></section>)}
      <h3>待核验事项</h3><ul>{current.pendingChecks.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <p className="section-note">{current.provider} / {current.model} · {current.configVersion}</p>
    </> : <p>{loading ? '正在读取资料…' : '尚未生成内部资料。生成前需要先分析项目，获取 README 等官方材料。'}</p>}
  </section>;
}
