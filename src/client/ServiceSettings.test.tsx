// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ServiceSettings } from './ServiceSettings';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('手动切换服务并刷新状态，失败保留当前服务和恢复提示', async () => {
  const settings = { analysisProvider: 'gpt', providers: [{ id: 'gpt', model: 'gpt-6.1-sol', configured: true }, { id: 'deepseek', model: 'backup', configured: true }], search: { model: 'search', configured: true }, searchProviders: [{ id: 'configured', model: 'search', configured: true }], images: { configured: false, note: '未接入' } };
  // 服务信息是设置页内嵌区块，桩须按路径返回各自结构，不能把设置对象当成服务信息。
  const profile = { public: { environment: '', guidance: '', exclusions: '', price: '', timing: '', support: '' }, internalNote: '' };
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init) => new Response(JSON.stringify(init?.method === 'PUT' ? (fail ? { error: '服务配置不可用，请重试' } : { provider: 'deepseek' }) : String(url).includes('service-profile') ? profile : settings), { status: init?.method === 'PUT' && fail ? 422 : 200 })));
  const changed = vi.fn(async () => {});
  render(<ServiceSettings onChanged={changed} />);
  const button = await screen.findByRole('button', { name: /切换到 DeepSeek/ });
  const user = userEvent.setup();
  await user.click(button);
  expect((await screen.findByRole('alert')).textContent).toContain('请重试');
  expect(changed).not.toHaveBeenCalled();
  fail = false; await user.click(button);
  expect(changed).toHaveBeenCalledOnce();
  expect((screen.getByRole('button', { name: /切换到 DeepSeek/ }) as HTMLButtonElement).disabled).toBe(true);
});

it('分析、检索与配图分别展示配置与真实核验状态，切换分析不改动另两项', async () => {
  const settings = {
    analysisProvider: 'gpt',
    providers: [{ id: 'gpt', model: 'gpt-6.1-sol', configured: true }, { id: 'deepseek', model: 'deepseek-v4-pro', configured: true }],
    search: { model: 'gpt-6.1-sol', configured: true, provider: 'gpt' },
    searchProviders: [{ id: 'configured', model: 'deepseek-v4-pro', configured: true }, { id: 'gpt', model: 'gpt-6.1-sol', configured: true }],
    images: { configured: true, driverModel: 'gpt-6.1-sol', imageModel: 'gpt-image-2.5-sunburst', provider: 'gateway.test' },
    capabilities: {
      analysis: { status: 'succeeded', at: '2026-10-30T06:00:00Z', provider: 'gateway.test', model: 'gpt-6.1-sol' },
      search: { status: 'failed', at: '2026-10-30T07:00:00Z', provider: 'gateway.test', model: 'gpt-6.1-sol', error: '外部服务请求超时' },
      image: { status: 'succeeded', at: '2026-10-30T08:00:00Z', provider: 'gateway.test', model: 'gpt-image-2.5-sunburst' },
    },
  };
  const profile = { public: { environment: '', guidance: '', exclusions: '', price: '', timing: '', support: '' }, internalNote: '' };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init) => new Response(JSON.stringify(init?.method === 'PUT' ? { provider: 'deepseek' } : String(url).includes('service-profile') ? profile : settings), { status: 200 })));
  render(<ServiceSettings onChanged={async () => {}} />);
  // 图片模型与驱动它的文本模型分行显示，不从文本模型名推断生图模型。
  expect(await screen.findByText(/图片模型 gpt-image-2.5-sunburst/)).toBeTruthy();
  expect(screen.getByText(/发起调用的文本模型 gpt-6.1-sol/)).toBeTruthy();
  expect(screen.getByText(/生图能力：最近一次真实调用成功 · gpt-image-2.5-sunburst · /)).toBeTruthy();
  expect(screen.getByText(/检索能力：最近一次真实调用失败 · gpt-6.1-sol · .* · 外部服务请求超时/)).toBeTruthy();
  expect(screen.getByText(/分析能力：最近一次真实调用成功/)).toBeTruthy();
  expect(screen.getByText(/不等于/)).toHaveProperty('textContent', expect.stringContaining('已配置'));
  const searchLine = screen.getByText(/^公开检索：/).textContent;
  const imageLine = screen.getByText(/^配图：/).textContent;
  await userEvent.setup().click(screen.getByRole('button', { name: /切换到 DeepSeek/ }));
  expect(screen.getByText(/^公开检索：/).textContent).toBe(searchLine);
  expect(screen.getByText(/^配图：/).textContent).toBe(imageLine);
});
