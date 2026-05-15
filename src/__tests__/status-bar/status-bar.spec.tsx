// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act, waitFor } from '@testing-library/react';

// PROD 下 sandboxSweep 会涂掉 navigator.clipboard,LM UI 必须走 cached ref
// (getCachedClipboard)。测试也走 mock 的 cached clipboard,而非 hack
// navigator.clipboard 全局 — 这样 spec 才真锁住「PROD 仍能复制」。
const { writeTextMock } = vi.hoisted(() => ({
  writeTextMock: vi.fn<(text: string) => Promise<void>>(),
}));
vi.mock('../../plugins/sandbox-sweep', () => ({
  getCachedFetch: () => globalThis.fetch,
  getCachedClipboard: () => ({
    readText: () => Promise.resolve(''),
    writeText: writeTextMock,
  }),
  sandboxSweep: () => {},
}));

import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { StatusBar } from '../../shell/StatusBar';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useTerminalStore } from '../../stores/terminal.store';
import { _resetAgentAuthForTest, useAgentAuthStore } from '../../stores/agent-auth.store';
import { coApp } from '../../plugins/co-app';
import { StatusBarRegistry } from '../../plugins/registries/StatusBarRegistry';

interface FakeApi {
  mcp?: { getStdioConfig: ReturnType<typeof vi.fn> };
  agentAuth?: { revoke: ReturnType<typeof vi.fn> };
}

function installApi(api: FakeApi): void {
  Object.defineProperty(window, 'api', {
    value: api,
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  _resetAgentAuthForTest();
  useEditorStore.setState({ tabs: [], activeTabId: null });
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
  useTerminalStore.setState({ sessions: [], activeId: null });
  // 用类型断言覆盖 readonly,测试隔离需要(每 it 用全新 registry)
  (coApp as { statusBar: StatusBarRegistry }).statusBar =
    new StatusBarRegistry();
  writeTextMock.mockReset();
  writeTextMock.mockResolvedValue(undefined);
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('StatusBar — 左侧 workspace', () => {
  it('root=null → 「无工作区」', () => {
    installApi({});
    const { container } = render(<StatusBar />);
    expect(container.textContent).toContain('无工作区');
  });

  it('root 有 → basename + main 占位', () => {
    installApi({});
    useWorkspaceStore.setState({
      root: '/Users/foo/projects/myapp',
      recentRoots: [],
    });
    const { container } = render(<StatusBar />);
    expect(container.textContent).toContain('myapp');
    expect(container.textContent).toContain('main');
  });

  it('sidebarOpen=false → 「侧栏已隐藏」', () => {
    installApi({});
    useLayoutUiStore.setState({ sidebarOpen: false });
    const { container } = render(<StatusBar />);
    expect(container.textContent).toContain('侧栏已隐藏');
  });
});

describe('StatusBar — 右侧文件信息', () => {
  it('activeTab=null → 只显示 UTF-8', () => {
    installApi({});
    const { container } = render(<StatusBar />);
    expect(container.textContent).toContain('UTF-8');
    expect(container.textContent).not.toMatch(/行/);
  });

  it('active 有 + dirty → basename + ● + 行/词/字符', () => {
    installApi({});
    useEditorStore.setState({
      tabs: [
        {
          id: '/x.md',
          filePath: '/x.md',
          content: 'hello world\nsecond line',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/x.md',
    });
    const { container } = render(<StatusBar />);
    expect(container.textContent).toContain('x.md');
    expect(container.textContent).toContain('●'); // dirty 标记
    expect(container.textContent).toMatch(/2\s*行/);
    expect(container.textContent).toMatch(/词/);
    expect(container.textContent).toContain('LF');
  });

  it('active.filePath=null(草稿) → 「未命名」', () => {
    installApi({});
    useEditorStore.setState({
      tabs: [
        {
          id: 'untitled-1',
          filePath: null,
          content: 'x',
          originalContent: '',
          dirty: false,
        },
      ],
      activeTabId: 'untitled-1',
    });
    const { container } = render(<StatusBar />);
    expect(container.textContent).toContain('未命名');
  });
});

describe('StatusBar — agent 计数', () => {
  it('agent session 0 → 不显示 agent 按钮', () => {
    installApi({});
    useTerminalStore.setState({
      sessions: [
        {
          id: 't1',
          title: 'shell',
          cwd: '/',
          originHint: 'user',
          createdAt: 0,
          exitCode: null,
          ownerWindowId: 1,
        },
      ],
      activeId: 't1',
    });
    const { container } = render(<StatusBar />);
    expect(container.textContent).not.toMatch(/\d+ agent/);
  });

  it('agent session > 0 → 显示「N agent」按钮', () => {
    installApi({
      agentAuth: { revoke: vi.fn().mockResolvedValue({ ok: true }) },
    });
    useTerminalStore.setState({
      sessions: [
        {
          id: 't1',
          title: 'codex',
          cwd: '/',
          originHint: 'agent',
          createdAt: 0,
          exitCode: null,
          ownerWindowId: 1,
        },
        {
          id: 't2',
          title: 'shell',
          cwd: '/',
          originHint: 'user',
          createdAt: 0,
          exitCode: null,
          ownerWindowId: 1,
        },
      ],
      activeId: 't1',
    });
    const { container } = render(<StatusBar />);
    expect(container.textContent).toMatch(/1 agent/);
  });
});

describe('StatusBar — 插件 statusBar items', () => {
  it('左侧 item render → 出现在左半', () => {
    installApi({});
    coApp.statusBar.register({
      id: 'plugin.left',
      side: 'left',
      render: () => 'PLUGIN_LEFT',
    });
    const { container } = render(<StatusBar />);
    expect(container.textContent).toContain('PLUGIN_LEFT');
  });

  it('右侧 item render → 出现', () => {
    installApi({});
    coApp.statusBar.register({
      id: 'plugin.right',
      side: 'right',
      render: () => 'PLUGIN_RIGHT',
    });
    const { container } = render(<StatusBar />);
    expect(container.textContent).toContain('PLUGIN_RIGHT');
  });

  it('subscribe 后注册新 item → 立即出现', () => {
    installApi({});
    const { container } = render(<StatusBar />);
    expect(container.textContent).not.toContain('LATE_ITEM');
    act(() => {
      coApp.statusBar.register({
        id: 'plugin.late',
        side: 'right',
        render: () => 'LATE_ITEM',
      });
    });
    expect(container.textContent).toContain('LATE_ITEM');
  });
});

describe('StatusBar — MCP 复制', () => {
  it('ok=true + claudeAddCommand 有 + clipboard 写成功 → 文案变「已复制」', async () => {
    installApi({
      mcp: {
        getStdioConfig: vi.fn().mockResolvedValue({
          ok: true,
          data: { available: true, claudeAddCommand: 'claude mcp add ...' },
        }),
      },
    });
    const { container } = render(<StatusBar />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '复制 MCP 配置')!;
    fireEvent.click(btn);
    await waitFor(() => {
      expect(container.textContent).toContain('已复制');
    });
    expect(writeTextMock).toHaveBeenCalledWith('claude mcp add ...');
  });

  // 回归 issue #16/#17:PROD 下 sandboxSweep 涂掉 navigator.clipboard 后,
  // 旧代码直接调 navigator.clipboard.writeText 必抛 TypeError → UI 显
  // 「复制失败」。修后走 getCachedClipboard,正常路径不抛;但 cached
  // writeText 自身因系统拒绝抛错时,UI 仍要 fallback 到「复制失败」。
  it('clipboard writeText 抛错 → 「复制失败」', async () => {
    writeTextMock.mockRejectedValueOnce(new Error('denied'));
    installApi({
      mcp: {
        getStdioConfig: vi.fn().mockResolvedValue({
          ok: true,
          data: { available: true, claudeAddCommand: 'claude mcp add ...' },
        }),
      },
    });
    const { container } = render(<StatusBar />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '复制 MCP 配置')!;
    fireEvent.click(btn);
    await waitFor(() => {
      expect(container.textContent).toContain('复制失败');
    });
  });

  it('available=false → 「MCP 不可用」', async () => {
    installApi({
      mcp: {
        getStdioConfig: vi.fn().mockResolvedValue({
          ok: true,
          data: { available: false },
        }),
      },
    });
    const { container } = render(<StatusBar />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '复制 MCP 配置')!;
    fireEvent.click(btn);
    await waitFor(() => {
      expect(container.textContent).toContain('MCP 不可用');
    });
  });

  it('IPC ok=false → 「复制失败」', async () => {
    installApi({
      mcp: {
        getStdioConfig: vi
          .fn()
          .mockResolvedValue({ ok: false, code: 'X', message: 'oops' }),
      },
    });
    const { container } = render(<StatusBar />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '复制 MCP 配置')!;
    fireEvent.click(btn);
    await waitFor(() => {
      expect(container.textContent).toContain('复制失败');
    });
  });
});

describe('StatusBar — agent 撤销', () => {
  it('点 N agent 按钮 + 用户 confirm → revoke + coApi.agentAuth.revoke', async () => {
    const revoke = vi.fn().mockResolvedValue({ ok: true });
    installApi({ agentAuth: { revoke } });
    useTerminalStore.setState({
      sessions: [
        {
          id: 't1',
          title: 'codex',
          cwd: '/',
          originHint: 'agent',
          createdAt: 0,
          exitCode: null,
          ownerWindowId: 1,
        },
      ],
      activeId: 't1',
    });
    useAgentAuthStore.setState({ pending: null, sessionGranted: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { container } = render(<StatusBar />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => /\d+\s*agent/.test(b.textContent ?? ''))!;
    fireEvent.click(btn);

    await waitFor(() => {
      expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
      expect(revoke).toHaveBeenCalled();
    });
    confirmSpy.mockRestore();
  });

  it('用户取消 confirm → 不调 revoke', async () => {
    const revoke = vi.fn();
    installApi({ agentAuth: { revoke } });
    useTerminalStore.setState({
      sessions: [
        {
          id: 't1',
          title: 'a',
          cwd: '/',
          originHint: 'agent',
          createdAt: 0,
          exitCode: null,
          ownerWindowId: 1,
        },
      ],
      activeId: 't1',
    });
    useAgentAuthStore.setState({ pending: null, sessionGranted: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const { container } = render(<StatusBar />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => /\d+\s*agent/.test(b.textContent ?? ''))!;
    fireEvent.click(btn);

    await Promise.resolve();
    expect(revoke).not.toHaveBeenCalled();
    expect(useAgentAuthStore.getState().sessionGranted).toBe(true);
    confirmSpy.mockRestore();
  });
});
