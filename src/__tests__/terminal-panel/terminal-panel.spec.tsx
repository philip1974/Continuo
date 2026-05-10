// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act, waitFor } from '@testing-library/react';

vi.mock('../../panels/Terminal/useTerminal', () => ({
  useTerminal: () => ({
    containerRef: { current: null },
    isReady: true,
  }),
}));

import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { TerminalPanel } from '../../panels/Terminal/TerminalPanel';
import {
  useTerminalStore,
  type TerminalSession,
} from '../../stores/terminal.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

interface FakeTerminal {
  create: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  onSessionsChanged: ReturnType<typeof vi.fn>;
}

function installTerminal(over: Partial<FakeTerminal> = {}): {
  terminal: FakeTerminal;
  triggerSessionsChanged: (sessions: TerminalSession[]) => void;
  unsub: ReturnType<typeof vi.fn>;
} {
  let cb: ((sessions: TerminalSession[]) => void) | null = null;
  const unsub = vi.fn();
  const terminal: FakeTerminal = {
    create: vi.fn().mockResolvedValue({ ok: true, data: { id: 't-new' } }),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    listSessions: vi.fn().mockResolvedValue({
      ok: true,
      data: { sessions: [] },
    }),
    onSessionsChanged: vi.fn((fn) => {
      cb = fn;
      return unsub;
    }),
    ...over,
  };
  Object.defineProperty(window, 'api', {
    value: { terminal },
    writable: true,
    configurable: true,
  });
  captureLmApi();
  return {
    terminal,
    triggerSessionsChanged: (sessions) => cb?.(sessions),
    unsub,
  };
}

function s(over: Partial<TerminalSession>): TerminalSession {
  return {
    id: 't1',
    title: 'shell',
    cwd: '/',
    originHint: 'user',
    createdAt: 0,
    exitCode: null,
    ...over,
  };
}

beforeEach(() => {
  _resetLmApiForTest();
  useTerminalStore.setState({ sessions: [], activeId: null });
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('TerminalPanel — 初始化', () => {
  it('mount 调 listSessions + 订阅 onSessionsChanged', async () => {
    const { terminal } = installTerminal();
    // 先把 sessions 填上,防自动 spawn 干扰断言
    useTerminalStore.setState({
      sessions: [s({ id: 't1' })],
      activeId: 't1',
    });
    render(<TerminalPanel />);
    await waitFor(() => {
      expect(terminal.listSessions).toHaveBeenCalled();
      expect(terminal.onSessionsChanged).toHaveBeenCalled();
    });
  });

  it('listSessions ok=true → replaceSnapshot 写入 store', async () => {
    const { terminal } = installTerminal({
      listSessions: vi.fn().mockResolvedValue({
        ok: true,
        data: { sessions: [s({ id: 'pre1' })] },
      }),
    });
    useTerminalStore.setState({
      sessions: [s({ id: 'old' })],
      activeId: 'old',
    });
    render(<TerminalPanel />);
    await waitFor(() => {
      const ids = useTerminalStore.getState().sessions.map((x) => x.id);
      expect(ids).toContain('pre1');
    });
    expect(terminal.listSessions).toHaveBeenCalledTimes(1);
  });

  it('onSessionsChanged 推送 → replaceSnapshot', async () => {
    const { triggerSessionsChanged } = installTerminal();
    useTerminalStore.setState({
      sessions: [s({ id: 'old' })],
      activeId: 'old',
    });
    render(<TerminalPanel />);
    await waitFor(() => {
      // ensure subscribe ran
    });
    act(() => {
      triggerSessionsChanged([s({ id: 'new1' }), s({ id: 'new2' })]);
    });
    const ids = useTerminalStore.getState().sessions.map((x) => x.id);
    expect(ids).toEqual(['new1', 'new2']);
  });

  it('卸载时调 unsub', async () => {
    const { unsub } = installTerminal();
    useTerminalStore.setState({
      sessions: [s({ id: 't1' })],
      activeId: 't1',
    });
    const { unmount } = render(<TerminalPanel />);
    await waitFor(() => {});
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});

describe('TerminalPanel — handleNew', () => {
  it('点 + 按钮 → coApi.terminal.create + setActive(新 id)', async () => {
    const { terminal } = installTerminal();
    useTerminalStore.setState({
      sessions: [s({ id: 't1' })],
      activeId: 't1',
    });
    useWorkspaceStore.setState({ root: '/proj', recentRoots: [] });
    const { container } = render(<TerminalPanel />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label="新建终端"]',
      ) as HTMLButtonElement,
    );
    await waitFor(() => {
      // env.COLORFGBG 由 useTheme().resolved 决定 — 测试环境(jsdom 无 dark
      // class) ThemeProvider 默认 'dark',所以 COLORFGBG='15;0'。
      expect(terminal.create).toHaveBeenCalledWith({
        cwd: '/proj',
        env: { COLORFGBG: '15;0' },
      });
      expect(useTerminalStore.getState().activeId).toBe('t-new');
    });
  });

  it('create ok=false → alert + console.warn,不 setActive', async () => {
    const { terminal } = installTerminal({
      // listSessions 永不 resolve,避免 replaceSnapshot 重置 store
      listSessions: vi.fn(() => new Promise(() => {})),
      create: vi.fn().mockResolvedValue({
        ok: false,
        code: 'EBUSY',
        message: 'pty unavailable',
      }),
    });
    const alertSpy = vi
      .spyOn(window, 'alert')
      .mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useTerminalStore.setState({
      sessions: [s({ id: 'keep' })],
      activeId: 'keep',
    });
    const { container } = render(<TerminalPanel />);
    fireEvent.click(
      container.querySelector(
        'button[aria-label="新建终端"]',
      ) as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(terminal.create).toHaveBeenCalled();
    });
    expect(alertSpy).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(useTerminalStore.getState().activeId).toBe('keep');
    alertSpy.mockRestore();
  });
});

describe('TerminalPanel — handleClose', () => {
  it('点 tab 上 close × → terminal.remove(id)', async () => {
    const { terminal } = installTerminal();
    useTerminalStore.setState({
      sessions: [s({ id: 't1' }), s({ id: 't2' })],
      activeId: 't1',
    });
    const { container } = render(<TerminalPanel />);
    // TerminalTabs 关闭按钮:常见命名是 'close-tab' / aria-label,我们点 t2
    // 任意 close 按钮触发即可
    const tabCloseBtns = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label*="关闭"], button[aria-label*="Close"]',
    );
    expect(tabCloseBtns.length).toBeGreaterThan(0);
    fireEvent.click(tabCloseBtns[0]!);
    await waitFor(() => {
      expect(terminal.remove).toHaveBeenCalled();
    });
  });
});

describe('TerminalPanel — 空态', () => {
  it('sessions=[] → 显示「无活跃终端」+ 「+ 新建终端」按钮', async () => {
    // 绕过自动 spawn:listSessions 永不 resolve,但 sessions 仍 = []
    installTerminal({
      listSessions: vi.fn(() => new Promise(() => {})),
    });
    // 由于自动 spawn flag 是 module-level,可能已经在前面测试中被设过。
    // 我们关注的是渲染态:sessions=[] 时 UI 显示空态文案,这与 spawn 无关。
    const { container } = render(<TerminalPanel />);
    expect(container.textContent).toContain('无活跃终端');
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).some(
        (b) => b.textContent?.includes('新建终端'),
      ),
    ).toBe(true);
  });
});

describe('TerminalPanel — 渲染', () => {
  it('每个 session 一个 absolute div,active 显示 visible,其它 hidden', () => {
    installTerminal();
    useTerminalStore.setState({
      sessions: [s({ id: 't1' }), s({ id: 't2' })],
      activeId: 't2',
    });
    const { container } = render(<TerminalPanel />);
    const divs = container.querySelectorAll(
      'div.absolute',
    ) as NodeListOf<HTMLDivElement>;
    expect(divs.length).toBe(2);
    // 第二个(t2)是 active
    expect(divs[0]!.style.visibility).toBe('hidden');
    expect(divs[1]!.style.visibility).toBe('visible');
  });

  // 回归 issue #15:xterm cols 缩窄时 reflow 跳过带 ANSI 的旧行,
  // .xterm-screen 仍按旧 cols × cellWidth 撑大,视觉溢出穿透 dockview /
  // main / 一路跑出窗口边缘。host overflow-x-hidden 兜不住更外层的溢出,
  // 必须在 TerminalPanel 顶层 overflow-hidden 把溢出截在 panel 边界内。
  it('TerminalPanel 顶层 overflow-hidden — 防 xterm 内容穿出窗口 (#15)', () => {
    installTerminal();
    const { container } = render(<TerminalPanel />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/\boverflow-hidden\b/);
  });
});
