import { useEffect, useState } from 'react';
import type { CapabilityCheck } from '../shared/contracts';
import { ServiceProfileSettings } from './ServiceProfileSettings';
import { errorMessage, request } from './api';

interface Settings {
  analysisProvider: string;
  providers: { id: string; model: string; configured: boolean; protocol: string }[];
  search: { model: string; configured: boolean; provider?: string };
  searchProviders?: { id: string; model: string; configured: boolean }[];
  images: { configured: boolean; driverModel?: string; imageModel?: string; provider?: string | null; capability?: CapabilityCheck | null };
  capabilities?: { analysis?: CapabilityCheck; search?: CapabilityCheck; image?: CapabilityCheck };
}

const capabilityLabels = { succeeded: '最近一次真实调用成功', failed: '最近一次真实调用失败' };

/** 密钥只在服务端配置；切换分析服务不改变检索或配图服务。 */
export function ServiceSettings({ onChanged, onDirtyChange }: { onChanged: () => Promise<void>; onDirtyChange?: (dirty: boolean) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void request<Settings>('/api/settings', { signal: controller.signal }).then(setSettings).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, []);
  async function change(provider: string) {
    setPending(true); setError('');
    try {
      await request('/api/settings/analysis', { method: 'PUT', body: JSON.stringify({ provider }) });
      setSettings(current => current ? { ...current, analysisProvider: provider } : current);
      await onChanged();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  async function changeSearch(provider: string) {
    setPending(true); setError('');
    try {
      await request('/api/settings/search', { method: 'PUT', body: JSON.stringify({ provider }) });
      const next = await request<Settings>('/api/settings');
      setSettings(next); await onChanged();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  return <section aria-label="服务设置">
    <h2>服务设置</h2>
    {error && <p role="alert">{error}</p>}
    {!settings ? <p>正在读取设置…</p> : <>
      <p>分析服务：{settings.analysisProvider === 'gpt' ? 'GPT' : 'DeepSeek'}。切换仅影响随后启动的任务，运行中的任务继续使用原服务。</p>
      {settings.providers.map(provider => <button key={provider.id} disabled={pending || !provider.configured || settings.analysisProvider === provider.id} onClick={() => void change(provider.id)}>
        切换到 {provider.id === 'gpt' ? 'GPT' : 'DeepSeek'} · {provider.model}{!provider.configured ? '（未配置）' : ''}
      </button>)}
      <p>公开检索：{settings.search.model || '未配置'}{settings.search.configured ? '（已填写配置，能力须单独核验）' : '（未配置）'}</p>
      {(settings.searchProviders ?? []).map(provider => <button key={provider.id} disabled={pending || !provider.configured || settings.search.provider === provider.id} onClick={() => void changeSearch(provider.id)}>检索使用{provider.id === 'gpt' ? ' GPT 网关' : '原检索配置'} · {provider.model}</button>)}
      <p>检索服务单独选择，不随分析服务切换；仅影响随后启动的任务。</p>
      <p>配图：{settings.images.configured ? `已配置 ${settings.images.provider ?? '未填写地址'} · 图片模型 ${settings.images.imageModel}（发起调用的文本模型 ${settings.images.driverModel}）` : '未配置：请在服务端 .env 填写 GPT 网关凭据与 GPT_IMAGE_MODEL'}。配图服务独立选择，不随分析服务切换。</p>
      {(['analysis', 'search', 'image'] as const).map(kind => <CapabilityRow key={kind} label={kind === 'analysis' ? '分析能力' : kind === 'search' ? '检索能力' : '生图能力'} check={settings.capabilities?.[kind] ?? (kind === 'image' ? settings.images.capability ?? null : null)} />)}
      <p className="section-note">能力状态只记录本地工作台真实发起过的调用；“已配置”不等于“已核验”，未显示记录说明尚未在本服务运行中调用过。</p>
    </>}
    <ServiceProfileSettings onDirtyChange={onDirtyChange} />
  </section>;
}

/** 能力状态来自本工作台真实发起过的调用记录，不据配置项推断可用性。 */
function CapabilityRow({ label, check }: { label: string; check: CapabilityCheck | null }) {
  const detail = check ? `${check.model ?? '模型未记录'} · ${new Date(check.at).toLocaleString('zh-CN')}${check.error ? ` · ${check.error}` : ''}` : '本服务运行内尚无真实调用记录';
  return <p>{`${label}：${check ? `${capabilityLabels[check.status]} · ` : ''}${detail}`}</p>;
}
