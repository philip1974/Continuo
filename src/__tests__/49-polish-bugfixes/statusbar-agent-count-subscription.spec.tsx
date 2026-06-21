// @vitest-environment jsdom
// 打磨 R39(codex 性能,延续 R22/R24):StatusBar 改为订阅派生 agent 计数,不再订阅
// 整份 terminal sessions。终端标题/退出状态/普通用户终端变化(agent 数不变)不再
// 触发状态栏重渲(用 Profiler 计 commit 验证)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Profiler } from 'react';
import { render, cleanup, act } from '@testing-library/react';

vi.mock('../../plugins/sandbox-sweep', () => ({
  getCachedFetch: () => globalThis.fetch,
  getCachedClipboard: () => ({
    readText: () => Promise.resolve(''),
    writeText: vi.fn().mockResolvedValue(undefined),
  }),
  sandboxSweep: () => {},
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { StatusBar } from '../../shell/StatusBar';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useTerminalStore } from '../../stores/terminal.store';
import { useEditorStore } from '../../stores/editor.store';
import { coApp } from '../../plugins/co-app';
import { StatusBarRegistry } from '../../plugins/registries/StatusBarRegistry';

function sess(id: string, originHint: 'agent' | 'user', title = id) {
  return { id, title, cwd: '/', originHint, createdAt: 0, exitCode: null, ownerWindowId: 1 };
}

function installApi(): void {
  Object.defineProperty(window, 'api', { value: {}, writable: true, configurable: true });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
  useEditorStore.setState({ tabs: [], activeTabId: null });
  useTerminalStore.setState({
    sessions: [sess('a1', 'agent'), sess('u1', 'user')],
    activeId: 'a1',
  });
  (coApp as { statusBar: StatusBarRegistry }).statusBar = new StatusBarRegistry();
});
afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
});

describe('打磨 R39 — StatusBar 订阅派生 agent 计数', () => {
  it('非 agent session 变化(计数不变)→ StatusBar 不重渲', () => {
    installApi();
    const onRender = vi.fn();
    render(
      <Profiler id="sb" onRender={onRender}>
        <StatusBar />
      </Profiler>,
    );
    const base = onRender.mock.calls.length;
    expect(base).toBeGreaterThan(0);

    // 改 user 终端的 title(agent 计数仍是 1)
    act(() => {
      useTerminalStore.setState((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === 'u1' ? { ...x, title: 'renamed-user' } : x,
        ),
      }));
    });

    expect(onRender.mock.calls.length).toBe(base); // 无新 commit
  });

  it('新增 agent session → 重渲 + 计数+1', () => {
    installApi();
    const { container } = render(<StatusBar />);
    expect(container.textContent).toMatch(/1 agent/);

    act(() => {
      useTerminalStore.setState((s) => ({
        sessions: [...s.sessions, sess('a2', 'agent')],
      }));
    });

    expect(container.textContent).toMatch(/2 agent/);
  });
});
