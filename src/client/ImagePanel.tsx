import { useEffect, useMemo, useRef, useState } from 'react';
import type { MaterialImage, ReferenceImage, VisualStyle } from '../shared/contracts';
import { errorMessage, request } from './api';

const slotLabels: Record<number, string> = { 1: '封面主图', 2: '功能场景图', 3: '使用条件提示图' };
const statusLabels = { pending: '尚未生成', succeeded: '已生成', failed: '生成失败' };
const kindLabels = { generated: '首次生成', revised: '按补充要求修改', restored: '恢复历史配图' };

interface ImagesResponse { images: MaterialImage[] }

/**
 * 配图工作台：一次点击推进整套三张，遇到失败立即停下并保留已成功的图片，
 * 由经营者决定重试失败项还是修改某一张，不静默连续付费调用。
 */
export function ImagePanel({ projectId, materialVersionId, platformName, startSignal = 0, onSettled }: { projectId: number; materialVersionId: string; platformName: string; startSignal?: number; onSettled?: (count: number) => void }) {
  const [images, setImages] = useState<MaterialImage[]>([]);
  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [instruction, setInstruction] = useState('');
  const [style, setStyle] = useState<VisualStyle>({ name: '', direction: '', avoid: '' });
  const [styleOverride, setStyleOverride] = useState(false);
  const [progress, setProgress] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [historySlot, setHistorySlot] = useState<number | null>(null);
  const lock = useRef(false);

  const load = async (signal?: AbortSignal) => {
    const result = await request<{ images: MaterialImage[] }>(`/api/projects/${projectId}/images`, { signal });
    setImages(result.images);
  };
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      request<{ images: MaterialImage[] }>(`/api/projects/${projectId}/images`, { signal: controller.signal }),
      request<{ references: ReferenceImage[] }>('/api/references', { signal: controller.signal }),
      request<{ style: VisualStyle; inherited: boolean }>(`/api/settings/visual-style?projectId=${projectId}`, { signal: controller.signal }),
    ]).then(([imageResult, referenceResult, styleResult]) => {
      if (controller.signal.aborted) return;
      setImages(imageResult.images); setReferences(referenceResult.references);
      setStyle(styleResult.style); setStyleOverride(!styleResult.inherited);
    }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [projectId]);

  // 槽位取该文案版本下最近一条记录；已成功且有文件才显示成图。
  const slotsFor = (materialId: string, list: MaterialImage[]) => ([1, 2, 3] as const).map(slot => {
    const history = list.filter(item => item.materialVersionId === materialId && item.slot === slot);
    const latest = history[0] ?? null;
    return { slot, latest, history, current: latest && latest.status === 'succeeded' && latest.fileName ? latest : null };
  });
  const slots = useMemo(() => slotsFor(materialVersionId, images), [images, materialVersionId]);
  const done = slots.filter(item => item.current).length;
  const failed = slots.filter(item => item.latest?.status === 'failed');
  // 回调用 ref 持有，避免父组件每次渲染传入新函数导致回报循环；只在真的动过配图后回报，挂载时不上报。
  const settledRef = useRef(onSettled);
  useEffect(() => { settledRef.current = onSettled; });
  // 文案区询问“是否同步更新配图”，经营者点确认后通过 startSignal 触发一次整套生成。
  const startedRef = useRef(startSignal);
  useEffect(() => {
    if (startSignal === startedRef.current) return;
    startedRef.current = startSignal;
    void generateSet();
  }, [startSignal]);

  async function run(payload: object, path: string) {
    const result = await request<ImagesResponse>(path, { method: 'POST', body: JSON.stringify(payload) });
    const list = result.images ?? [];
    if (result.images) setImages(result.images);
    reportDone(list);
    return list;
  }

  /** 只在配图真的变化后向文案区回报张数，避免用初始 0 覆盖已知的旧版配图数。 */
  function reportDone(list: MaterialImage[]) {
    settledRef.current?.(slotsFor(materialVersionId, list).filter(item => item.current).length);
  }

  /** 第一未完成的槽位：以响应回来的记录为准，不依赖上一次渲染的状态快照。 */
  function nextOpen(materialVersionId: string, list: MaterialImage[]) {
    for (const slot of [1, 2, 3] as const) {
      const latest = list.filter(item => item.materialVersionId === materialVersionId && item.slot === slot)[0];
      if (latest?.status !== 'succeeded') return slot;
    }
    return null;
  }

  async function generateSet() {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(''); setMessage('');
    let list = images;
    try {
      // 一次点击最多推进三张，循环以本地槽位判定为唯一依据，不依赖响应字段，避免异常返回时连续付费调用。
      for (let made = 0; made < 3; made++) {
        const slot = nextOpen(materialVersionId, list);
        if (slot === null) { setMessage('这个平台的一套配图已完成'); break; }
        setProgress(`正在为${platformName}生成第 ${slot} 张（${slotLabels[slot]}）…`);
        const result = await request<ImagesResponse>(`/api/projects/${projectId}/images`, { method: 'POST', body: JSON.stringify({ action: 'generate', materialVersionId, instruction, references: chosen }) });
        list = result.images ?? list;
        setImages(list);
        reportDone(list);
      }
      if (nextOpen(materialVersionId, list) === null) setMessage('这个平台的一套配图已完成');
    } catch (cause) {
      // 某一张失败时服务端保留其余成图；重新拉取列表，让界面继续显示已经拿到的那几张。
      setError(`${errorMessage(cause)} 已生成的图片保留，可只重试失败的这张。`);
      await load().catch(() => undefined);
    } finally { lock.current = false; setPending(false); setProgress(''); }
  }

  async function revise(slot: number) {
    const target = slots.find(item => item.slot === slot)?.current ?? slots.find(item => item.slot === slot)?.latest;
    if (!target || lock.current) return;
    lock.current = true; setPending(true); setError(''); setMessage(''); setProgress(`正在按补充要求修改第 ${slot} 张（${slotLabels[slot]}）…`);
    try {
      await run({ action: 'revise', instruction, references: chosen }, `/api/projects/${projectId}/images/${target.id}`);
      setMessage('已保存为新的一版，旧图仍可恢复');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { lock.current = false; setPending(false); setProgress(''); }
  }

  async function restore(slot: number, imageId: string) {
    const target = slots.find(item => item.slot === slot)?.latest;
    if (!target) return;
    setError('');
    try {
      await run({ action: 'restore', restoreImageId: imageId }, `/api/projects/${projectId}/images/${target.id}`);
      setHistorySlot(null); setMessage('已把选中的旧图作为当前版本');
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function uploadReference(file: File) {
    setError('');
    try {
      const data = (await file.text()).split(',')[1] ?? '';
      const saved = await request<ReferenceImage>('/api/references', { method: 'POST', body: JSON.stringify({ label: file.name, fileName: file.name, data }) });
      setReferences(items => [saved, ...items]);
      setChosen(items => [...items, saved.fileName].slice(0, 4));
      setMessage('参考图已保存到本地素材库，勾选后用于下一次生图');
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function saveStyle() {
    setError('');
    try {
      await request('/api/settings/visual-style', { method: 'PUT', body: JSON.stringify({ style, projectId: styleOverride ? projectId : null }) });
      await request('/api/settings/visual-style', { method: 'PUT', body: JSON.stringify({ style: { name: style.name, direction: styleOverride ? style.direction : '', avoid: styleOverride ? style.avoid : '' }, projectId: null }) }).catch(() => undefined);
      setMessage(styleOverride ? '已保存这个项目的视觉风格' : '已保存为全局可复用视觉风格');
    } catch (cause) { setError(errorMessage(cause)); }
  }

  return <section className="image-panel" aria-label="配图">
    <div className="panel-heading"><h3>配图</h3><p className="section-note">{platformName} · 已生成 {done} / 3 张 · 每个平台默认一套三张</p></div>
    {progress && <p role="status" className="running-summary">{progress}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {message && <p role="status">{message}</p>}
    <div className="image-grid">{slots.map(({ slot, current, latest, history }) => <article key={slot} className="image-card">
      <header><strong>{slotLabels[slot]}</strong><span className={current ? 'analysis-label ready' : 'analysis-label'}>{statusLabels[latest?.status ?? 'pending']}</span></header>
      {current?.fileName
        ? <a href={`/api/projects/${projectId}/images/${current.id}/file`} target="_blank" rel="noreferrer"><img src={`/api/projects/${projectId}/images/${current.id}/file`} alt={`${platformName}第 ${slot} 张配图预览`} width={180} /></a>
        : <div className="image-placeholder">{latest?.status === 'failed' ? latest.error : '尚未生成真实图片'}</div>}
      <div className="image-meta">{current ? `${current.width ?? '尺寸未知'}×${current.height ?? ''} · ${current.model ?? '未知模型'} · ${kindLabels[current.kind]}` : latest?.status === 'failed' ? `失败于 ${new Date(latest.createdAt).toLocaleString('zh-CN')}` : '生成后显示尺寸、模型与版本来源'}</div>
      <div className="editor-actions">
        {current ? <a className="button button-secondary" href={`/api/projects/${projectId}/images/${current.id}/file?download=1`}>下载这一张</a> : <span className="section-note">暂无可下载的图片文件</span>}
        <button className="button button-secondary" disabled={pending || (!current && !latest)} onClick={() => setEditingSlot(editingSlot === slot ? null : slot)}>{current || latest ? '修改这一张' : '先生成这套配图'}</button>
        {history.length > 1 && <button className="button button-secondary" disabled={pending} onClick={() => setHistorySlot(historySlot === slot ? null : slot)}>查看这一张的历史（{history.length}）</button>}
      </div>
      {editingSlot === slot && (current || latest) && <div className="inline-form">
        <label className="field-label" htmlFor={`slot-instruction-${slot}`}>补充要求（只改这一张）</label>
        <textarea id={`slot-instruction-${slot}`} rows={2} maxLength={4000} value={instruction} onChange={event => { setInstruction(event.target.value); setMessage(''); }} placeholder="例如：顶部留白再多一点，不要出现英文" />
        <button className="button button-primary" disabled={pending || !instruction.trim()} onClick={() => void revise(slot)}>{pending ? '正在修改…' : '按补充要求重做这一张'}</button>
      </div>}
      {historySlot === slot && <ul className="history-list image-history">{history.map(item => <li key={item.id}>
        <div><strong>{kindLabels[item.kind]}{item.status === 'failed' ? '（失败）' : ''}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN')}</time></div>
        <p className="section-note">{item.instruction || item.error || '无补充要求记录'}</p>
        {item.status === 'succeeded' && item.id !== current?.id && <button className="button button-secondary" disabled={pending} onClick={() => void restore(slot, item.id)}>恢复这个版本</button>}
      </li>)}</ul>}
    </article>)}</div>
    <div className="editor-actions">
      <button className="button button-primary" disabled={pending || done === 3} onClick={() => void generateSet()}>{pending ? '正在生成配图…' : done === 3 ? '这套配图已完成' : failed.length ? '继续生成剩余配图' : '生成配图'}</button>
      {failed.length > 0 && <span className="section-note">{failed.map(item => slotLabels[item.slot]).join('、')}生成失败，重试只会补这几张。</span>}
    </div>
    <details className="style-details"><summary>视觉风格与参考图</summary>
      <p className="section-note">风格可保存为全局复用；勾选“仅用于这个项目”后只影响本项目。参考图只接受你确认拥有使用权的图片，保存在本地。</p>
      <label className="field-label">风格名称<input value={style.name} maxLength={100} onChange={event => setStyle(s => ({ ...s, name: event.target.value }))} placeholder="例如：清爽浅蓝插画" /></label>
      <label className="field-label">视觉方向<textarea rows={2} maxLength={2000} value={style.direction} onChange={event => setStyle(s => ({ ...s, direction: event.target.value }))} placeholder="例如：留白充足、主体突出、柔和光效" /></label>
      <label className="field-label">需要避免<textarea rows={2} maxLength={2000} value={style.avoid} onChange={event => setStyle(s => ({ ...s, avoid: event.target.value }))} placeholder="例如：深色背景、密集文字" /></label>
      <label className="field-label"><input type="checkbox" checked={styleOverride} onChange={event => setStyleOverride(event.target.checked)} /> 仅用于这个项目</label>
      <div className="editor-actions"><button className="button button-secondary" disabled={pending} onClick={() => void saveStyle()}>保存视觉风格</button></div>
      <label className="field-label">上传参考图<input type="file" accept="image/png,image/jpeg,image/webp" disabled={pending} onChange={event => { const file = event.target.files?.[0]; if (file) void uploadReference(file); event.target.value = ''; }} /></label>
      {references.length > 0 && <div className="reference-list">{references.map(item => <label key={item.id} className="reference-item">
        <input type="checkbox" checked={chosen.includes(item.fileName)} onChange={event => setChosen(list => event.target.checked ? [...list, item.fileName].slice(0, 4) : list.filter(name => name !== item.fileName))} />
        <img src={`/api/references/${item.fileName}`} alt="" width={48} />
        <span>{item.label || item.fileName}</span>
      </label>)}</div>}
      <p className="section-note">{chosen.length ? `下一次生图将使用 ${chosen.length} 张参考图。` : '未勾选参考图时，“修改这一张”默认以当前图片本身作为编辑输入。'}</p>
    </details>
  </section>;
}
