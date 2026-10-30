// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectBriefPanel } from './ProjectBriefPanel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('生成失败保留现有资料并说明失败，区分事实与未知', async () => {
  const item = { text: '官方声明支持 Docker', certainty: 'fact', evidenceIds: ['readme'] };
  const old = { id: 'old', projectId: 1, createdAt: '2026-10-30T00:00:00Z', provider: 'gateway.example', model: 'gpt', configVersion: 'v1', purpose: [item], environment: [{ text: '最低内存未知', certainty: 'unknown', evidenceIds: [] }], dependencies: [item], limitations: [item], pendingChecks: ['许可证待核验'] };
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(JSON.stringify(init?.method === 'POST' ? { error: '生成超时，已有资料保留，请重试' } : { briefs: [old] }), { status: init?.method === 'POST' ? 502 : 200 })));
  render(<ProjectBriefPanel projectId={1} canGenerate />);
  await screen.findByText('最低内存未知');
  await userEvent.click(screen.getByRole('button', { name: '生成中文资料' }));
  expect((await screen.findByRole('alert')).textContent).toContain('已有资料保留');
  expect(screen.getByText('最低内存未知')).toBeTruthy();
  expect(screen.getAllByText('材料明确说明：').length).toBe(3);
  expect(screen.getByText('未知：')).toBeTruthy();
});
