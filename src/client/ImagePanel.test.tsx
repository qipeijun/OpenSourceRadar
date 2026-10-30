// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MaterialImage } from '../shared/contracts';
import { ImagePanel } from './ImagePanel';

const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'Content-Type': 'application/json' } });
const image = (overrides: Partial<MaterialImage>): MaterialImage => ({
  id: 'img-1', projectId: 1, platform: 'xiaohongshu', materialVersionId: 'text-v1', slot: 1, status: 'succeeded', kind: 'generated',
  prompt: '封面主图提示词', instruction: '', fileName: 'img-1.png', width: 1086, height: 1448, format: 'png',
  createdAt: '2026-10-30T02:00:00Z', parentId: null, restoredFromId: null, provider: 'gateway.test', model: 'gpt-image-2.5-sunburst', usage: null, inputSnapshot: null, error: null,
  ...overrides,
});
const emptyResponses = { slots: [], versions: [], references: [], style: { name: '', direction: '', avoid: '' }, inherited: true };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('配图部分失败与重试', () => {
  it('第二张失败时保留第一张成图并停止连续调用', async () => {
    const first = image({});
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts++;
        // 第一张成功但仍缺后两张；第二张直接失败。
        if (posts === 1) return json({ image: first, images: [first] }, 201);
        return json({ error: '功能场景图未生成：外部服务请求超时', image: image({ id: 'img-2', slot: 2, status: 'failed', fileName: null, error: '超时' }), images: [first, image({ id: 'img-2', slot: 2, status: 'failed', fileName: null, error: '超时' })] }, 502);
      }
      if (path === '/api/projects/1/images') return json({ ...emptyResponses, images: posts > 1 ? [first, image({ id: 'img-2', slot: 2, status: 'failed', fileName: null, error: '超时' })] : [] });
      return json(emptyResponses);
    }));
    render(<ImagePanel projectId={1} materialVersionId="text-v1" platformName="小红书" />);
    await screen.findByRole('heading', { name: '配图' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '生成配图' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('外部服务请求超时');
    expect(alert.textContent).toContain('已生成的图片保留，可只重试失败的这张。');
    await waitFor(() => expect(posts).toBe(2));
    // 第一张成图仍保留在界面上，第二张显示失败而不是占位假图。
    expect(screen.getAllByRole('img', { name: /小红书第 1 张配图预览/ })).toHaveLength(1);
    expect(screen.getByText('尚未生成真实图片')).toBeTruthy();
    expect(screen.getByRole('button', { name: '继续生成剩余配图' })).toBeTruthy();
  });
});

describe('单张修改与版本恢复', () => {
  it('按补充要求只改这一张，并可把旧图恢复为当前版本', async () => {
    const old = image({ id: 'img-old', fileName: 'old.png' });
    const revised = image({ id: 'img-new', fileName: 'new.png', kind: 'revised', parentId: 'img-old' });
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ path, body: JSON.parse(String(init.body)) });
        const next = path.includes('img-old') ? revised : image({ id: 'img-restored', fileName: 'old.png', kind: 'restored', parentId: 'img-new', restoredFromId: 'img-old' });
        return json({ image: next, images: [next, old] }, 201);
      }
      if (path === '/api/projects/1/images') return json({ ...emptyResponses, images: posts.length ? [revised, old] : [old] });
      return json(emptyResponses);
    }));
    const user = userEvent.setup();
    render(<ImagePanel projectId={1} materialVersionId="text-v1" platformName="小红书" />);
    await screen.findByRole('heading', { name: '配图' });
    await user.click(screen.getByRole('button', { name: '修改这一张' }));
    await user.type(screen.getByLabelText('补充要求（只改这一张）'), '顶部留白再多一点');
    await user.click(screen.getByRole('button', { name: '按补充要求重做这一张' }));
    await waitFor(() => expect(posts[0]).toEqual({ path: '/api/projects/1/images/img-old', body: { action: 'revise', instruction: '顶部留白再多一点', references: [] } }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('旧图仍可恢复'));
    // 历史里出现两个版本，当前版本不重复提供恢复按钮。
    await user.click(screen.getByRole('button', { name: /查看这一张的历史/ }));
    expect(screen.getAllByText('按补充要求修改')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '恢复这个版本' }));
    await waitFor(() => expect(posts[1]?.body).toMatchObject({ action: 'restore', restoreImageId: 'img-old' }));
  });
});

describe('重复提交防护', () => {
  it('一张仍在生成时禁用整套生成，不并发发起第二次调用', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    let posts = 0;
    const succeeded = image({});
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts++;
        await held;
        // 返回一套已完成的三张，循环应在第一次成功后停止，不再发起第二次付费调用。
        return json({ image: succeeded, images: [succeeded, image({ id: 'img-2', slot: 2 }), image({ id: 'img-3', slot: 3 })] }, 201);
      }
      if (path === '/api/projects/1/images') return json({ ...emptyResponses, images: [] });
      return json(emptyResponses);
    }));
    render(<ImagePanel projectId={1} materialVersionId="text-v1" platformName="小红书" />);
    const button = await screen.findByRole('button', { name: '生成配图' });
    const user = userEvent.setup();
    await user.click(button);
    await waitFor(() => expect(posts).toBe(1));
    expect(screen.getByRole('button', { name: '正在生成配图…' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('status')).toHaveProperty('textContent', expect.stringContaining('正在为小红书生成第 1 张'));
    await user.click(screen.getByRole('button', { name: '正在生成配图…' })).catch(() => undefined);
    expect(posts).toBe(1);
    release();
    // 三张都已成功后按钮转为完成态，不再接受新的整套生成。
    await waitFor(() => expect((screen.getByRole('button', { name: '这套配图已完成' }) as HTMLButtonElement).disabled).toBe(true));
  });
});

it('服务端连续返回不完整结果时，一次点击最多调用三次，不无限付费生成', async () => {
  const partial = image({});
  let posts = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; return json({ image: partial, images: [partial] }, 201); }
    if (path === '/api/projects/1/images') return json({ ...emptyResponses, images: [partial] });
    return json(emptyResponses);
  }));
  render(<ImagePanel projectId={1} materialVersionId="text-v1" platformName="小红书" />);
  await userEvent.setup().click(await screen.findByRole('button', { name: '生成配图' }));
  await waitFor(() => expect(posts).toBe(3));
  expect(posts).toBe(3);
});
