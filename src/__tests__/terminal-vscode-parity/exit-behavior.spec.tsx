// @vitest-environment jsdom
// BDD: terminal-vscode-parity / 3 终端进程退出(对齐 VSCode TerminalInstance._onProcessExit)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import type { DockviewApi } from 'dockview-react';

const hoisted = vi.hoisted(() => ({
  writes: [] as string[],
  onDataCbs: [] as Array<(data: string) => void>,
  keyHandlers: [] as Array<(e: KeyboardEvent) => boolean>,
  write: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(this: Record<string, unknown>) {
    Object.assign(this, {
      cols: 80,
      rows: 24,
      options: {},
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn((h: (e: KeyboardEvent) => boolean) => hoisted.keyHandlers.push(h)),
      onData: vi.fn((cb: (data: string) => void) => {
        hoisted.onDataCbs.push(cb);
        return { dispose: vi.fn() };
      }),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      write: vi.fn((d: string) => hoisted.writes.push(d)),
      dispose: vi.fn(),
    });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(() => ({ onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })), dispose: vi.fn() })),
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: vi.fn(() => ({ onContextLoss: vi.fn(), dispose: vi.fn() })) }));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    terminal: {
      resize: vi.fn().mockResolvedValue({ ok: true }),
      updateCwd: vi.fn().mockResolvedValue({ ok: true }),
      onData: vi.fn(() => vi.fn()),
      readHistory: vi.fn().mockResolvedValue({ ok: true, data: { data: '$ ', truncated: false } }),
      write: hoisted.write,
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: hoisted.notifyError } }));
vi.mock('@/plugins/settings/values-store', () => ({ useSettingValue: <T,>(_k: string, fb: T) => fb }));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';
import { useTerminalStore, type TerminalSession } from '../../stores/terminal.store';
import { reconcileTerminalPanels } from '../../shell/dock/DockReconciler';
import { shouldAutoCloseExitedSession, terminalPanelTitle } from '../../shell/dock/terminal-panel-id';
import { consumePanelCloseSuppressed } from '../../shell/dock/wrap-panel-close';
import { setLocale } from '../../i18n';

function session(id: string, over: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id,
    title: 'Terminal 1',
    cwd: '/w',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ownerWindowId: 1,
    ...over,
  };
}

function Host({ termId, onExitDismiss }: { termId: string; onExitDismiss: () => void }) {
  const { containerRef } = useTerminal(termId, { onExitDismiss });
  return createElement('div', { ref: containerRef });
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  setLocale('zh');
  hoisted.writes.length = 0;
  hoisted.onDataCbs.length = 0;
  hoisted.keyHandlers.length = 0;
  hoisted.write.mockReset().mockResolvedValue({ ok: true });
  useTerminalStore.setState({ sessions: [] });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setLocale('en');
});

describe('退出策略', () => {
  it('仅 user 会话且退出码 0 自动关闭;非 0 或 agent 会话保留面板', () => {
    expect(shouldAutoCloseExitedSession({ exitCode: 0, originHint: 'user' })).toBe(true);
    expect(shouldAutoCloseExitedSession({ exitCode: 1, originHint: 'user' })).toBe(false);
    expect(shouldAutoCloseExitedSession({ exitCode: 0, originHint: 'agent' })).toBe(false);
    expect(shouldAutoCloseExitedSession({ exitCode: null, originHint: 'user' })).toBe(false);
  });
  it('已退出的 tab 标题加本地化「(已退出)」后缀', () => {
    expect(terminalPanelTitle({ sessionId: 'term-1', sessionTitle: 'Terminal 1', exited: true })).toBe('Terminal 1 (已退出)');
    expect(terminalPanelTitle({ sessionId: 'term-1', sessionTitle: 'Terminal 1' })).toBe('Terminal 1');
  });
});

function fakeDock() {
  const panels = new Map<string, { id: string; api: { id: string; title: string; close: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn>; setActive: ReturnType<typeof vi.fn> } }>();
  const api = {
    panels: [] as unknown[],
    getPanel: (id: string) => panels.get(id),
    addPanel: (o: { id: string; title: string }) => {
      const p = { id: o.id, api: { id: o.id, title: o.title, close: vi.fn(), setTitle: vi.fn((t: string) => { p.api.title = t; }), setActive: vi.fn() } };
      panels.set(o.id, p);
      return p;
    },
    activePanel: undefined,
  };
  return { api: api as unknown as DockviewApi, panels };
}

describe('reconciler:退出码 0 的用户终端自动关闭(走用户关闭路径删会话)', () => {
  it('user 会话 null→0:关闭面板,且不是 reconciler 的「只收敛视图」关闭', () => {
    const { api, panels } = fakeDock();
    const live = session('term-a');
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [live] });
    const exited = session('term-a', { exitCode: 0 });
    reconcileTerminalPanels(api, { previousSessions: [live], nextSessions: [exited] });
    expect(panels.get('terminal-term-a')!.api.close).toHaveBeenCalledTimes(1);
    expect(consumePanelCloseSuppressed('terminal-term-a')).toBe(false);
  });
  it('user 会话 null→1:不关闭,标题加「(已退出)」', () => {
    const { api, panels } = fakeDock();
    const live = session('term-b');
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [live] });
    reconcileTerminalPanels(api, { previousSessions: [live], nextSessions: [session('term-b', { exitCode: 1 })] });
    const p = panels.get('terminal-term-b')!;
    expect(p.api.close).not.toHaveBeenCalled();
    expect(p.api.title).toBe('Terminal 1 (已退出)');
  });
  it('agent 会话 null→0:不关闭(main 侧会话记录仍供 agent 的 list_sessions 读 exit_code)', () => {
    const { api, panels } = fakeDock();
    const live = session('term-c', { originHint: 'agent' });
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [live] });
    reconcileTerminalPanels(api, { previousSessions: [live], nextSessions: [session('term-c', { originHint: 'agent', exitCode: 0 })] });
    expect(panels.get('terminal-term-c')!.api.close).not.toHaveBeenCalled();
  });
});

describe('useTerminal:退出后的终端内说明与输入', () => {
  it('非 0 退出:回放历史之后写退出说明 + 按任意键关闭;此后键入不发 IPC、任意键关闭面板', async () => {
    useTerminalStore.setState({ sessions: [session('t-exit1')] });
    const dismiss = vi.fn();
    render(createElement(Host, { termId: 't-exit1', onExitDismiss: dismiss }));
    await flush();
    act(() => useTerminalStore.setState({ sessions: [session('t-exit1', { exitCode: 2 })] }));
    const out = hoisted.writes.join('');
    expect(out.indexOf('$ ')).toBeLessThan(out.indexOf('终端进程已终止，退出代码：2'));
    expect(out).toContain('按任意键关闭终端');
    for (const cb of hoisted.onDataCbs) cb('x');
    await flush();
    expect(hoisted.write).not.toHaveBeenCalled();
    expect(hoisted.notifyError).not.toHaveBeenCalled();
    // 带 ⌘/Ctrl 的组合(复制等)不算「任意键」;普通键关闭
    const handler = hoisted.keyHandlers[0]!;
    handler(new KeyboardEvent('keydown', { key: 'c', metaKey: true }));
    expect(dismiss).not.toHaveBeenCalled();
    expect(handler(new KeyboardEvent('keydown', { key: 'a' }))).toBe(false);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
  it('用户会话 0 退出:不写说明(面板由 reconciler 关闭),输入也不再发 IPC', async () => {
    useTerminalStore.setState({ sessions: [session('t-exit0')] });
    const dismiss = vi.fn();
    render(createElement(Host, { termId: 't-exit0', onExitDismiss: dismiss }));
    await flush();
    act(() => useTerminalStore.setState({ sessions: [session('t-exit0', { exitCode: 0 })] }));
    expect(hoisted.writes.join('')).not.toContain('终端进程已终止');
    for (const cb of hoisted.onDataCbs) cb('x');
    await flush();
    expect(hoisted.write).not.toHaveBeenCalled();
  });
  it('挂载时会话已非 0 退出:回放后补写退出说明', async () => {
    useTerminalStore.setState({ sessions: [session('t-exited', { exitCode: 127 })] });
    render(createElement(Host, { termId: 't-exited', onExitDismiss: vi.fn() }));
    await flush();
    expect(hoisted.writes.join('')).toContain('退出代码：127');
  });
  it('运行中:键入照常发 IPC', async () => {
    useTerminalStore.setState({ sessions: [session('t-live')] });
    render(createElement(Host, { termId: 't-live', onExitDismiss: vi.fn() }));
    await flush();
    for (const cb of hoisted.onDataCbs) cb('ls');
    await flush();
    expect(hoisted.write).toHaveBeenCalledWith('t-live', 'ls');
  });
});

describe('三语文案', () => {
  it('退出说明 / 按任意键关闭 / 已退出后缀三语齐全', async () => {
    const { en } = await import('../../../electron/shared/i18n-locales/en');
    const { zh } = await import('../../../electron/shared/i18n-locales/zh');
    const { ko } = await import('../../../electron/shared/i18n-locales/ko');
    for (const cat of [en, zh, ko] as Array<Record<string, string>>) {
      expect(cat['panels.terminal.exit_notice']).toContain('{code}');
      expect(cat['panels.terminal.exit_press_any_key']).toBeTruthy();
      expect(cat['panels.terminal.exited_suffix']).toBeTruthy();
    }
  });
});
