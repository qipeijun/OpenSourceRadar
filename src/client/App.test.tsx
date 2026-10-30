// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Analysis, Project, ProjectDetail, StatusResponse } from '../shared/contracts';
import { dimensionKeys } from '../shared/contracts';
import App from './App';
import { ProjectPanel } from './ProjectPanel';

// 以下项目与分析仅为组件测试夹具，不进入产品页面或真实采集流程。
const project = (id = 1): Project => ({
  id, fullName: `example/tool-${id}`, url: `https://github.com/example/tool-${id}`,
  description: '办公文档处理工具', language: 'TypeScript', stars: 100, dailyStars: 12,
  sourceUrl: 'https://github.com/trending?since=daily', discoveredAt: '2026-10-30T01:00:00Z',
  lastSeenAt: '2026-10-30T01:00:00Z', scene: 'office', latestAnalysis: null, latestDecision: null, lastError: null,
});
const detail = (value: Project): ProjectDetail => ({ project: value, evidence: [], analyses: [], decisions: [] });
const status: StatusResponse = { analysisConfigured: false, searchConfigured: false, analysisModel: null, searchModel: null, batchSize: 10, activeRun: null, latestRun: null, projectCount: 0, analyzedCount: 0 };
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('自动发现工作台', () => {
  it('没有项目时直接发起发现，不要求填写项目链接', async () => {
    let discovered = false;
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/status') return json(status);
      if (path === '/api/projects') return json({ projects: discovered ? [project()] : [] });
      if (path === '/api/projects/1') return json(detail(project()));
      if (path === '/api/discover' && init?.method === 'POST') {
        discovered = true;
        return json({ id: 'run-1', kind: 'discover', status: 'succeeded', stage: '发现完成', startedAt: '2026-10-30T01:00:00Z', finishedAt: '2026-10-30T01:01:00Z', total: 1, completed: 1, errors: [], projectId: null }, 202);
      }
      throw new Error(`未预期请求 ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: '还没有候选项目' });
    expect(screen.queryByPlaceholderText('https://github.com/owner/repo')).toBeNull();
    await user.click(screen.getByRole('button', { name: /发现新项目/ }));
    const candidate = await screen.findByRole('button', { name: /tool-1/ });
    expect(fetchMock).not.toHaveBeenCalledWith('/api/projects/1', expect.anything());
    expect(screen.getByTitle(`榜单数据采集于 ${project().lastSeenAt}`)).toBeTruthy();
    await user.click(candidate);
    await screen.findByRole('heading', { name: 'tool-1' });
    expect(screen.getByText('日榜 +12')).toBeTruthy();
    expect(screen.queryByText('+12 今日')).toBeNull();
    expect(screen.getByText(/日榜增量不代表已验证持续增长/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/discover', expect.objectContaining({ method: 'POST', body: '{}' }));
    expect(screen.getByRole('button', { name: '分析这个项目' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('tab', { name: /证据来源/ }));
    expect(within(screen.getByRole('tabpanel', { name: /证据来源/ })).getByText('尚未收集证据，不能据此判断“没有中文教程”。')).toBeTruthy();
  });

  it('采集错误展示原因，不用空候选表示成功', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/status') return json(status);
      if (path === '/api/projects') return json({ projects: [] });
      return json({ error: 'GitHub Trending 页面解析失败' }, 502);
    }));
    render(<App />);
    await screen.findByRole('heading', { name: '还没有候选项目' });
    await userEvent.setup().click(screen.getByRole('button', { name: /发现新项目/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('GitHub Trending 页面解析失败'));
  });

  it('切换候选后，较晚返回的旧详情不会覆盖新项目', async () => {
    let resolveFirst: (value: Response) => void = () => undefined;
    let firstSignal: AbortSignal | null | undefined;
    const firstResponse = new Promise<Response>(resolve => { resolveFirst = resolve; });
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/status') return json(status);
      if (path === '/api/projects') return json({ projects: [project(1), project(2)] });
      if (path === '/api/projects/1') { firstSignal = init?.signal; return firstResponse; }
      if (path === '/api/projects/2') return json(detail(project(2)));
      throw new Error(`未预期请求 ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /tool-1/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/1', expect.anything()));
    await user.click(screen.getByRole('button', { name: '← 返回候选列表' }));
    expect(firstSignal?.aborted).toBe(true);
    await user.click(screen.getByRole('button', { name: /tool-2/ }));
    await screen.findByRole('heading', { name: 'tool-2' });
    await act(async () => { resolveFirst(json(detail(project(1)))); await firstResponse; });
    expect(screen.queryByRole('heading', { name: 'tool-1' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'tool-2' })).toBeTruthy();
  });
});

describe('人工选题判断', () => {
  it('只在明确保存后提交人的选择与当前分析版本', async () => {
    const analysis: Analysis = {
      id: 'analysis-1', projectId: 1, createdAt: '2026-10-30T01:10:00Z', provider: 'test-provider', model: 'test-model', ruleVersion: '1', prediction: '暂不可预测', usage: null,
      scene: 'office', sceneReason: '处理办公文档', recommendation: 'verify', summary: '先核验安装条件', whyNow: '出现关注线索', audience: '办公用户', contentGap: '资料不足，暂不能确认缺口', deliverable: '安装排错教程待验证', nextStep: '核验普通电脑安装', costs: '实测成本未知', counterEvidence: ['官方可能已有完整教程'], unknowns: ['未实际安装'], changeConditions: ['已有教程足够完整时不投入'], evidenceIds: [], dimensions: dimensionKeys.map(key => ({ key, level: 'unknown', reason: '测试夹具证据不足', evidenceIds: [] })),
    };
    const value = { ...project(), latestAnalysis: analysis };
    const fetchMock = vi.fn(async () => json({ id: 'decision-1' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const refresh = vi.fn(async () => undefined);
    render(<ProjectPanel detail={{ ...detail(value), analyses: [analysis] }} busy={false} canAnalyze onAnalyze={() => undefined} onRefresh={refresh} />);
    expect(screen.getByText('当前版本尚未启用 7 天预测，选题建议依据已有证据。')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '记录我的判断' }));
    await user.click(screen.getByRole('radio', { name: '决定实测' }));
    await user.type(screen.getByLabelText('判断理由'), '先验证安装是否可行');
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '保存我的判断' }));
    await screen.findByRole('status');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/1/decisions', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ analysisId: 'analysis-1', action: 'test', reason: '先验证安装是否可行' }),
    })));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
