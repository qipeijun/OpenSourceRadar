import { useEffect, useState } from 'react';
import type { PublicService } from '../shared/contracts';
import { errorMessage, request } from './api';

interface Profile { public: PublicService; internalNote: string }
const labels: Record<keyof PublicService, string> = { environment: '可承接的环境', guidance: '使用指导范围', exclusions: '不承接的需求', price: '已确认的价格说明', timing: '已确认的时间说明', support: '已确认的售后范围' };

export function ServiceProfileSettings({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [saved, setSaved] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const dirty = !!profile && JSON.stringify(profile) !== saved;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    const controller = new AbortController();
    void request<Profile>('/api/service-profile', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setProfile(result); setSaved(JSON.stringify(result)); } }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  async function save() {
    if (!profile || pending) return;
    setPending(true); setError(''); setMessage('');
    try { const result = await request<Profile>('/api/service-profile', { method: 'PUT', body: JSON.stringify(profile) }); setProfile(result); setSaved(JSON.stringify(result)); setMessage('服务信息已保存，随后生成的文案将使用这些信息'); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  return <section className="service-profile" aria-label="我的服务信息">
    <h2>我的服务信息</h2><p>仅填写已经确认、能够兑现的信息。未知留空，生成时不会自动补造收费、时间或售后承诺。</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!profile ? <p>正在读取服务信息…</p> : <form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={pending}>
      {(Object.keys(labels) as (keyof PublicService)[]).map(key => <label className="field-label" key={key}>{labels[key]}<textarea rows={2} maxLength={key === 'price' || key === 'timing' ? 500 : key === 'support' ? 1000 : 2000} value={profile.public[key]} onChange={event => { setMessage(''); setProfile(current => current ? { ...current, public: { ...current.public, [key]: event.target.value } } : current); }} /></label>)}
      <label className="field-label">内部备注（不进入对外文案）<textarea rows={3} maxLength={10000} value={profile.internalNote} onChange={event => { setMessage(''); setProfile(current => current ? { ...current, internalNote: event.target.value } : current); }} /></label>
      <p role="status">{dirty ? '服务信息尚未保存' : '服务信息已保存'}</p><button className="button button-primary" disabled={!dirty || pending}>{pending ? '正在保存…' : '保存服务信息'}</button>
    </fieldset></form>}
  </section>;
}
