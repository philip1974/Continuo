// @vitest-environment jsdom
// 打磨 R24(codex 性能):StatusBar 只订阅 active tab 派生 primitive,不再订阅整份
// tabs。非 active tab 的 content 变化(后台外部同步 / 保存推进 originalContent)
// 不应触发状态栏重渲;active 内容变化仍更新统计(用 Profiler 计 commit 验证)。
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
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useTerminalStore } from '../../stores/terminal.store';
import { coApp } from '../../plugins/co-app';
import { StatusBarRegistry } from '../../plugins/registries/StatusBarRegistry';

function mkTab(id: string, content: string, dirty = false) {
  return { id, filePath: id, content, originalContent: content, dirty };
}

function installApi(): void {
  Object.defineProperty(window, 'api', {
    value: {},
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
  useTerminalStore.setState({ sessions: [], activeId: null });
  useEditorStore.setState({
    tabs: [mkTab('/a.md', 'aaa'), mkTab('/b.md', 'bbb')],
    activeTabId: '/a.md',
  });
  (coApp as { statusBar: StatusBarRegistry }).statusBar = new StatusBarRegistry();
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
});

describe('打磨 R24 — StatusBar 窄订阅', () => {
  it('非 active tab content 变化 → StatusBar 不重渲', () => {
    installApi();
    const onRender = vi.fn();
    render(
      <Profiler id="sb" onRender={onRender}>
        <StatusBar />
      </Profiler>,
    );
    const base = onRender.mock.calls.length;
    expect(base).toBeGreaterThan(0);

    // 改 /b.md(非 active)的 content
    act(() => {
      useEditorStore.setState((s) => ({
        tabs: s.tabs.map((tb) =>
          tb.id === '/b.md' ? { ...tb, content: 'bbb changed in background' } : tb,
        ),
      }));
    });

    expect(onRender.mock.calls.length).toBe(base); // 无新 commit
  });

  it('active tab content 变化 → 重渲 + 统计更新', () => {
    installApi();
    const { container } = render(<StatusBar />);
    // 'aaa' = 1 行
    expect(container.textContent).toMatch(/1\s*行/);

    act(() => {
      useEditorStore.setState((s) => ({
        tabs: s.tabs.map((tb) =>
          tb.id === '/a.md' ? { ...tb, content: 'aaa\nsecond\nthird' } : tb,
        ),
      }));
    });

    expect(container.textContent).toMatch(/3\s*行/);
  });
});
