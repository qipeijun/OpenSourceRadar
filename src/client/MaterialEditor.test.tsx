// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { MaterialVersion } from '../shared/contracts';
import { MaterialEditor } from './MaterialEditor';

const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'Content-Type': 'application/json' } });
const version = (overrides: Partial<MaterialVersion>): MaterialVersion => ({
  id: 'v1', projectId: 1, platform: 'xiaohongshu', titles: ['整理本地笔记的小工具'], body: '可以按主题整理本地笔记。需要配置协助可以先说明场景。',
  evidenceIds: ['e1'], createdAt: '2026-10-30T02:00:00Z', parentId: null, kind: 'generated', instruction: '', provider: 'gateway.test', model: 'gpt-6.1-sol', inputSnapshot: null, usage: null,
  ...overrides,
});
const images = { images: [], slots: [], versions: [] };

/** 只记录写请求，读请求返回当前列表，模拟服务端版本只追加。 */
function harness(versions: MaterialVersion[], imageCounts: Record<string, number> = {}) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      const created = version({ id: `v${versions.length + 1}`, titles: path.includes('materials') && posts.at(-1)?.body.action === 'revise' ? ['更短的标题'] : (posts.at(-1)?.body.titles as string[]) ?? [], body: (posts.at(-1)?.body.body as string) ?? '按补充要求重写的正文', kind: posts.at(-1)?.body.action === 'manual' ? 'manual' : 'revised', parentId: String(posts.at(-1)?.body.baseVersionId ?? '') });
      versions.unshift(created);
      return json(created, 201);
    }
    if (path === '/api/references') return json({ references: [] });
    if (path.startsWith('/api/settings/visual-style')) return json({ style: { name: '', direction: '', avoid: '' }, inherited: true });
    if (path === '/api/projects/1/materials') return json({ versions, imageCounts });
    if (path === '/api/projects/1/images') return json({ ...images, imageCounts });
    if (init?.method === 'POST' && path === '/api/projects/1/images') return json({ image: {}, images: [] });
    throw new Error(`未预期请求 ${path}`);
  }));
  return posts;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('人工编辑保存为新版本，未保存时切换平台先确认', async () => {
  const posts = harness([version({})]);
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const user = userEvent.setup();
  render(<MaterialEditor projectId={1} projectName="example/tool" onDirtyChange={() => undefined} />);
  const bodyBox = await screen.findByLabelText('正文');
  expect(screen.getAllByRole('status').map(el => el.textContent)).toEqual(['已保存']);
  await user.clear(bodyBox);
  await user.type(bodyBox, '人工补充：支持导出 Markdown。');
  expect(screen.getAllByRole('status').map(el => el.textContent)).toEqual(['尚未保存']);
  // 放弃修改时不提交，也不切换平台。
  await user.selectOptions(screen.getByLabelText('素材平台'), 'xianyu');
  expect(confirmSpy).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('素材平台')).toHaveProperty('value', 'xiaohongshu');
  await user.click(screen.getByRole('button', { name: '保存文案' }));
  await waitFor(() => expect(posts[0]?.body).toMatchObject({ action: 'manual', baseVersionId: 'v1', titles: ['整理本地笔记的小工具'] }));
  expect(posts[0]!.body.body).toBe('人工补充：支持导出 Markdown。');
  await waitFor(() => expect(screen.getAllByRole('status').map(el => el.textContent)).toEqual(['已保存', '已保存为新版本']));
  confirmSpy.mockReturnValue(true);
  await user.selectOptions(screen.getByLabelText('素材平台'), 'xianyu');
  expect(screen.getByLabelText('素材平台')).toHaveProperty('value', 'xianyu');
  // 平台与版本状态在标题区合并展示，跨文本节点需按整块内容断言。
  const heading = screen.getByRole('heading', { name: '素材编辑' }).parentElement!;
  expect(heading.textContent).toContain('闲鱼');
  expect(heading.textContent).toContain('尚无文案');
});

it('只按选择范围修改标题，正文保持人工编辑内容', async () => {
  const posts = harness([version({ id: 'v1' })]);
  const user = userEvent.setup();
  render(<MaterialEditor projectId={1} projectName="example/tool" onDirtyChange={() => undefined} />);
  await screen.findByLabelText('正文');
  await user.type(screen.getByLabelText('补充要求'), '标题再短一点');
  await user.selectOptions(screen.getByLabelText('修改范围'), 'titles');
  await user.click(screen.getByRole('button', { name: '按要求修改文案' }));
  await waitFor(() => expect(posts[0]?.body).toEqual({ action: 'revise', baseVersionId: 'v1', scope: 'titles', instruction: '标题再短一点' }));
  expect(screen.getByLabelText('正文')).toHaveProperty('value', '按补充要求重写的正文');
});

it('恢复历史版本时提交旧版本 ID，并保留当前版本记录', async () => {
  const posts = harness([version({ id: 'v2', kind: 'revised' }), version({ id: 'v1', titles: ['最早的标题'], body: '最早的正文' })]);
  const user = userEvent.setup();
  render(<MaterialEditor projectId={1} projectName="example/tool" onDirtyChange={() => undefined} />);
  await screen.findByLabelText('正文');
  await user.selectOptions(screen.getByLabelText('素材版本'), 'v1');
  expect(screen.getByLabelText('正文')).toHaveProperty('value', '最早的正文');
  await user.click(screen.getByRole('button', { name: '恢复这个版本' }));
  await waitFor(() => expect(posts[0]?.body).toEqual({ action: 'restore', baseVersionId: 'v2', restoreVersionId: 'v1' }));
  // 恢复是新增一版而不是改写历史。
  expect(screen.getAllByRole('option', { name: /恢复旧版|生成|补充要求修改/ }).length).toBeGreaterThanOrEqual(3);
});

it('导出入口只指向已保存版本，编辑中不可导出', async () => {
  harness([version({})]);
  const user = userEvent.setup();
  render(<MaterialEditor projectId={1} projectName="example/tool" onDirtyChange={() => undefined} />);
  const exportLink = await screen.findByRole('link', { name: '打包导出这一套' });
  expect(exportLink.getAttribute('href')).toBe('/api/projects/1/export?version=v1');
  const bodyBox = screen.getByLabelText('正文');
  await user.clear(bodyBox);
  await user.type(bodyBox, '还没保存');
  expect(screen.queryByRole('link', { name: '打包导出这一套' })).toBeNull();
  expect(screen.getByText('先保存人工编辑，再按补充要求修改，避免丢失当前内容。')).toBeTruthy();
});

/** 旧版已有 3 张配图时，文案更新后必须询问而不是自动重画。 */
function syncHarness() {
  let generatePosts = 0;
  const versions = [version({ id: 'v1' })];
  const succeeded = { id: 'img-1', projectId: 1, platform: 'xiaohongshu' as const, materialVersionId: 'v2', slot: 1, status: 'succeeded' as const, kind: 'generated' as const, prompt: 'p', instruction: '', fileName: 'img-1.png', width: 1, height: 1, format: 'png', createdAt: '2026-10-30T03:00:00Z', parentId: null, restoredFromId: null, provider: 'gateway.test', model: 'gpt-image-2.5-sunburst', usage: null, inputSnapshot: null, error: null };
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (path === '/api/projects/1/images') {
        generatePosts++;
        // 返回整套三张，界面应停止继续调用。
        return json({ image: succeeded, images: [succeeded, { ...succeeded, id: 'img-2', slot: 2 }, { ...succeeded, id: 'img-3', slot: 3 }] }, 201);
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const created = version({ id: `v${versions.length + 1}`, kind: 'manual' as const, parentId: String(body.baseVersionId ?? ''), body: String(body.body ?? '') });
      versions.unshift(created);
      return json(created, 201);
    }
    if (path === '/api/references') return json({ references: [] });
    if (path.startsWith('/api/settings/visual-style')) return json({ style: { name: '', direction: '', avoid: '' }, inherited: true });
    if (path === '/api/projects/1/materials') return json({ versions, imageCounts: { v1: 3 } });
    if (path === '/api/projects/1/images') return json({ images: [], slots: [], versions: [] });
    throw new Error(`未预期请求 ${path}`);
  }));
  return { generatePosts: () => generatePosts };
}

async function editAndSave(user: ReturnType<typeof userEvent.setup>) {
  const bodyBox = await screen.findByLabelText('正文');
  await user.clear(bodyBox);
  await user.type(bodyBox, '正文有改动');
  await user.click(screen.getByRole('button', { name: '保存文案' }));
  await screen.findByText(/上一版有 3 张配图/);
}

it('文案更新后询问是否同步配图，选择暂不更新时不发起生图调用', async () => {
  const harness = syncHarness();
  const user = userEvent.setup();
  render(<MaterialEditor projectId={1} projectName="example/tool" onDirtyChange={() => undefined} />);
  await editAndSave(user);
  await user.click(screen.getByRole('button', { name: '暂不更新' }));
  expect(screen.queryByText(/上一版有 3 张配图/)).toBeNull();
  expect(harness.generatePosts()).toBe(0);
});

it('确认同步后才为新版本文案生成配图', async () => {
  const harness = syncHarness();
  const user = userEvent.setup();
  render(<MaterialEditor projectId={1} projectName="example/tool" onDirtyChange={() => undefined} />);
  await editAndSave(user);
  await user.click(screen.getByRole('button', { name: '现在生成配图' }));
  await waitFor(() => expect(harness.generatePosts()).toBe(1));
  expect(screen.queryByText(/上一版有 3 张配图/)).toBeNull();
});
