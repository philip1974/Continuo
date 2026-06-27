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
import { notify } from '../../notifications/notify';

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

  // a11y(A37,A35 同族):状态栏 dirty 只用视觉 ● → AT 须有「未保存」文本,● 标 aria-hidden。
  it('a11y · dirty → AT 可读「未保存」文本 + ● aria-hidden;clean → 无', () => {
    installApi({});
    useEditorStore.setState({
      tabs: [
        {
          id: '/x.md',
          filePath: '/x.md',
          content: 'a',
          originalContent: 'b',
          dirty: true,
        },
      ],
      activeTabId: '/x.md',
    });
    const { container, rerender } = render(<StatusBar />);
    expect(container.textContent).toContain('未保存的更改');
    const dot = Array.from(container.querySelectorAll('span')).find(
      (s) => s.textContent === '●',
    )!;
    expect(dot.getAttribute('aria-hidden')).toBe('true');

    // clean → 无未保存文本
    useEditorStore.setState({
      tabs: [
        {
          id: '/x.md',
          filePath: '/x.md',
          content: 'a',
          originalContent: 'a',
          dirty: false,
        },
      ],
      activeTabId: '/x.md',
    });
    rerender(<StatusBar />);
    expect(container.textContent).not.toContain('未保存的更改');
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
    // i18n(I19):agent 计数走 catalog,默认 locale=zh 渲染「1 个 agent」。用 locale-无关
    // 断言(count + 'agent'),不再钉死旧英文 '1 agent';并验 zh 本地化(含「个」)非纯英文。
    expect(container.textContent).toMatch(/1.*agent/);
    expect(container.textContent).toContain('个 agent'); // zh catalog,非英文 raw '1 agent'
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

  // 打磨 R6:StatusBar 改为一次订阅取全量(全局 priority 排序)再 filter 分侧。
  // 同侧多项必须仍按 priority 升序渲染(守护 getAll().filter 保序 ≡ getBySide)。
  it('同侧多 item → 按 priority 升序渲染', () => {
    installApi({});
    coApp.statusBar.register({
      id: 'plugin.l.hi',
      side: 'left',
      priority: 200,
      render: () => 'L_HI',
    });
    coApp.statusBar.register({
      id: 'plugin.l.lo',
      side: 'left',
      priority: 1,
      render: () => 'L_LO',
    });
    const { container } = render(<StatusBar />);
    const txt = container.textContent ?? '';
    expect(txt.indexOf('L_LO')).toBeGreaterThanOrEqual(0);
    expect(txt.indexOf('L_LO')).toBeLessThan(txt.indexOf('L_HI'));
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
  // a11y(A82,A74 同族):按钮可见文本随复制状态变化,aria-label 须稳定表「复制 MCP 配置」语义,
  // 不随状态漂移成结果文本(结果由 live region 播报)。
  it('a11y · MCP copy 按钮 aria-label 稳定(不随复制状态漂移)', async () => {
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
    ).find((b) => (b.getAttribute('aria-label') ?? '').includes('claude mcp add'))!;
    expect(btn).toBeDefined();
    const before = btn.getAttribute('aria-label');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(container.textContent).toContain('已复制'); // 可见文本变了
    });
    // 但 aria-label 不变(稳定动作语义)
    expect(btn.getAttribute('aria-label')).toBe(before);
  });

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
    // a11y(A51):复制结果须在 live region(role=status)播报,焦点在按钮时也能听到。
    const status = container.querySelector('[role=status]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain('已复制');
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

  // a11y(A115,A50 同族):getStdioConfig() IPC reject 时也须归「复制失败」,不被 void 丢弃。
  it('getStdioConfig reject → 「复制失败」(IPC 异常不静默)', async () => {
    installApi({
      mcp: {
        getStdioConfig: vi.fn().mockRejectedValue(new Error('ipc down')),
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
    ).find((b) => /\d+.*agent/.test(b.textContent ?? ''))!;
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
    ).find((b) => /\d+.*agent/.test(b.textContent ?? ''))!;
    fireEvent.click(btn);

    await Promise.resolve();
    expect(revoke).not.toHaveBeenCalled();
    expect(useAgentAuthStore.getState().sessionGranted).toBe(true);
    confirmSpy.mockRestore();
  });

  // codex 复审 loop R18:revoke IPC 失败不得静默伪成功(否则 UI 显示已撤销但 main 的 agent
  // PTY/token 仍存活 = 安全相关谎报)。失败 → 回滚本地授权态 + notify.error。
  it('R18: revoke IPC 返 ok:false → 回滚 sessionGranted=true + notify.error', async () => {
    const errSpy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    const revoke = vi.fn().mockResolvedValue({ ok: false, code: 'KILL_FAILED' });
    installApi({ agentAuth: { revoke } });
    useTerminalStore.setState({
      sessions: [
        { id: 't1', title: 'a', cwd: '/', originHint: 'agent', createdAt: 0, exitCode: null, ownerWindowId: 1 },
      ],
      activeId: 't1',
    });
    useAgentAuthStore.setState({ pending: null, sessionGranted: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { container } = render(<StatusBar />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => /\d+.*agent/.test(b.textContent ?? ''))!;
    fireEvent.click(btn);

    await waitFor(() => {
      expect(errSpy).toHaveBeenCalled();
    });
    // 关键:撤销实际没成功 → 本地授权态回滚为 true,不谎报已撤销
    expect(useAgentAuthStore.getState().sessionGranted).toBe(true);
    confirmSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('R18: revoke IPC reject → 同样回滚 + notify.error', async () => {
    const errSpy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    const revoke = vi.fn().mockRejectedValue(new Error('ipc down'));
    installApi({ agentAuth: { revoke } });
    useTerminalStore.setState({
      sessions: [
        { id: 't1', title: 'a', cwd: '/', originHint: 'agent', createdAt: 0, exitCode: null, ownerWindowId: 1 },
      ],
      activeId: 't1',
    });
    useAgentAuthStore.setState({ pending: null, sessionGranted: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { container } = render(<StatusBar />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => /\d+.*agent/.test(b.textContent ?? ''))!;
    fireEvent.click(btn);

    await waitFor(() => {
      expect(errSpy).toHaveBeenCalled();
    });
    expect(useAgentAuthStore.getState().sessionGranted).toBe(true);
    confirmSpy.mockRestore();
    errSpy.mockRestore();
  });

  // race(R92):两次 revoke 并发,先发的迟到失败不得用旧 wasGranted 快照把 sessionGranted 回滚成
  // true 覆盖后发已成功的撤销(否则 renderer 误以为仍授权,后续 agent auth 被无提示放行)。
  it('R92: 先发 revoke 迟到失败,在后发成功之后不回滚 sessionGranted', async () => {
    const errSpy = vi.spyOn(notify, 'error').mockImplementation(() => {});
    let rejectFirst: (e: unknown) => void = () => {};
    const revoke = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({ ok: true });
    installApi({ agentAuth: { revoke } });
    useTerminalStore.setState({
      sessions: [
        { id: 't1', title: 'a', cwd: '/', originHint: 'agent', createdAt: 0, exitCode: null, ownerWindowId: 1 },
      ],
      activeId: 't1',
    });
    useAgentAuthStore.setState({ pending: null, sessionGranted: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { container } = render(<StatusBar />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => /\d+.*agent/.test(b.textContent ?? ''))!;

    // 第一次 revoke(A):wasGranted=true,sessionGranted→false,IPC#1 在途(deferred,将失败)。
    fireEvent.click(btn);
    // 第二次 revoke(B):IPC#2 成功(resolve ok)→ 不回滚。
    fireEvent.click(btn);
    await waitFor(() => {
      expect(revoke).toHaveBeenCalledTimes(2);
    });

    // A 的 IPC 此刻才迟到失败:因 A 非最新 revoke,不得回滚。
    rejectFirst(new Error('late fail'));
    await Promise.resolve();
    await Promise.resolve();

    // 关键:sessionGranted 保持 false(后发 B 已成功撤销,A 迟到失败未覆盖)。
    expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
    confirmSpy.mockRestore();
    errSpy.mockRestore();
  });
});
