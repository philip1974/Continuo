// @vitest-environment jsdom
// BDD: terminal-vscode-parity / 4 关闭仍有子进程的终端须确认(VSCode terminal.integrated.confirmOnKill 默认 editor)
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({ runningProcess: vi.fn() }));
vi.mock('@/lib/co-api', () => ({
  coApi: { terminal: { runningProcess: hoisted.runningProcess } },
}));

import { wrapPanelClose, markPanelCloseSuppressed } from '../../shell/dock/wrap-panel-close';
import {
  TerminalKillConfirmHost,
  terminalCloseGuard,
  useTerminalKillConfirmStore,
} from '../../shell/dock/terminal-close-confirm';
import { useClosingStore } from '../../stores/closing.store';
import { useTerminalStore, type TerminalSession } from '../../stores/terminal.store';
import { EXIT_DURATION_MS } from '../../shell/motion/tokens';
import { isShellProcessName } from '../../../electron/shared/shell-process-name';
import { setLocale } from '../../i18n';

function session(id: string, exitCode: number | null = null): TerminalSession {
  return { id, title: 'Terminal 1', cwd: '/w', originHint: 'user', createdAt: 1, exitCode, ownerWindowId: 1 };
}

function terminalPanel(sessionId: string, close = vi.fn()) {
  return {
    params: { sessionId },
    view: { contentComponent: 'terminal' },
    api: { id: `terminal-${sessionId}`, title: 'Terminal 1', close },
  };
}

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

beforeEach(() => {
  setLocale('zh');
  useClosingStore.setState({ ids: new Set() });
  useTerminalKillConfirmStore.setState({ pending: null });
  hoisted.runningProcess.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setLocale('en');
});

describe('main:前台进程名与 shell 名比较', () => {
  it('同名(含登录 shell 的「-」前缀、路径、.exe、大小写)= 无子进程', () => {
    expect(isShellProcessName('zsh', '/bin/zsh')).toBe(true);
    expect(isShellProcessName('-zsh', '/bin/zsh')).toBe(true);
    expect(isShellProcessName('/usr/bin/bash', '/bin/bash')).toBe(true);
    expect(isShellProcessName('PowerShell.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(true);
    expect(isShellProcessName('sleep', '/bin/zsh')).toBe(false);
    expect(isShellProcessName('vim', '/bin/zsh')).toBe(false);
  });
  it('IPC:terminal:running_process 走 owner 校验 + zod 入参,preload 暴露 runningProcess', () => {
    const ipc = readFileSync('electron/main/ipc/terminal.ipc.ts', 'utf-8');
    expect(ipc).toMatch(/ownerScopedHandle\(\s*TERMINAL_CHANNELS\.RUNNING_PROCESS,\s*idOnlyInputSchema/);
    const channels = readFileSync('electron/shared/terminal-channels.ts', 'utf-8');
    expect(channels).toContain("RUNNING_PROCESS: 'terminal:running_process'");
    const preload = readFileSync('electron/preload/index.ts', 'utf-8');
    expect(preload).toContain('ipcRenderer.invoke(TERMINAL_CHANNELS.RUNNING_PROCESS, { id })');
  });
  it('依赖的 server-node SessionManager 内部形态(sessions Map → pty)仍在', () => {
    const src = readFileSync('node_modules/@continuo-terminal/server-node/src/session-manager.ts', 'utf-8');
    expect(src).toContain('private sessions = new Map<string, SessionState>()');
    expect(src).toMatch(/const state: SessionState = \{\s*id,\s*pty,/);
  });
});

describe('wrapPanelClose 的关闭守卫(所有 api.close 入口共用)', () => {
  it('守卫同步放行 → 照旧立即进入关闭动画', () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const panel = terminalPanel('s1', close);
    wrapPanelClose(panel as never, () => true);
    panel.api.close();
    expect(useClosingStore.getState().ids.has('terminal-s1')).toBe(true);
    vi.advanceTimersByTime(EXIT_DURATION_MS);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('守卫异步拒绝 → 不关;期间重复 close 不重复询问', async () => {
    let resolve!: (ok: boolean) => void;
    const guard = vi.fn(() => new Promise<boolean>((r) => { resolve = r; }));
    const close = vi.fn();
    const panel = terminalPanel('s2', close);
    wrapPanelClose(panel as never, guard);
    panel.api.close();
    panel.api.close();
    expect(guard).toHaveBeenCalledTimes(1);
    resolve(false);
    await flush();
    expect(useClosingStore.getState().ids.has('terminal-s2')).toBe(false);
  });
  it('守卫异步放行 → 进入关闭', async () => {
    let resolve!: (ok: boolean) => void;
    const panel = terminalPanel('s3');
    wrapPanelClose(panel as never, () => new Promise<boolean>((r) => { resolve = r; }));
    panel.api.close();
    expect(useClosingStore.getState().ids.has('terminal-s3')).toBe(false);
    resolve(true);
    await flush();
    expect(useClosingStore.getState().ids.has('terminal-s3')).toBe(true);
  });
  it('reconciler 收敛视图的关闭不询问', () => {
    const guard = vi.fn(() => false);
    const panel = terminalPanel('s4');
    wrapPanelClose(panel as never, guard);
    markPanelCloseSuppressed('terminal-s4');
    panel.api.close();
    expect(guard).not.toHaveBeenCalled();
    expect(useClosingStore.getState().ids.has('terminal-s4')).toBe(true);
  });
  it('DockShell 给每个面板挂终端关闭守卫,并渲染确认框宿主', () => {
    const src = readFileSync('src/shell/dock/DockShell.tsx', 'utf-8');
    expect(src).toContain('wrapPanelClose(panel, terminalCloseGuard)');
    expect(src).toContain('onDidAddPanel(wrapPanelCloseGuarded)');
    expect(src).toContain('panels.forEach(wrapPanelCloseGuarded)');
    expect(src).toContain('<TerminalKillConfirmHost />');
  });
});

describe('terminalCloseGuard', () => {
  it('非终端面板 / 已退出会话:同步放行,不查进程', () => {
    useTerminalStore.setState({ sessions: [session('done', 1)] });
    expect(terminalCloseGuard({ params: {}, view: { contentComponent: 'editor' }, api: { id: 'editor', title: 'Editor' } } as never)).toBe(true);
    expect(terminalCloseGuard(terminalPanel('done') as never)).toBe(true);
    expect(hoisted.runningProcess).not.toHaveBeenCalled();
  });
  it('只有 shell 在跑 / 查询失败:直接关', async () => {
    useTerminalStore.setState({ sessions: [session('idle'), session('err')] });
    hoisted.runningProcess.mockResolvedValueOnce({ ok: true, data: { process: null } });
    await expect(terminalCloseGuard(terminalPanel('idle') as never)).resolves.toBe(true);
    hoisted.runningProcess.mockResolvedValueOnce({ ok: false, code: 'X' });
    await expect(terminalCloseGuard(terminalPanel('err') as never)).resolves.toBe(true);
    expect(useTerminalKillConfirmStore.getState().pending).toBeNull();
  });
  it('有子进程:弹破坏性确认框(默认焦点在取消),取消 → 不关,终止 → 关', async () => {
    useTerminalStore.setState({ sessions: [session('busy')] });
    render(createElement(TerminalKillConfirmHost));
    hoisted.runningProcess.mockResolvedValue({ ok: true, data: { process: 'sleep' } });

    const first = terminalCloseGuard(terminalPanel('busy') as never) as Promise<boolean>;
    await flush();
    expect(screen.getByText('终止正在运行的进程?')).toBeTruthy();
    expect(screen.getByText(/sleep/)).toBeTruthy();
    const cancel = screen.getByRole('button', { name: '取消' });
    expect(cancel.getAttribute('data-autofocus')).not.toBeNull();
    fireEvent.click(cancel);
    await expect(first).resolves.toBe(false);

    const second = terminalCloseGuard(terminalPanel('busy') as never) as Promise<boolean>;
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '终止' }));
    await expect(second).resolves.toBe(true);
  });
  it('三语文案齐全', async () => {
    const { en } = await import('../../../electron/shared/i18n-locales/en');
    const { zh } = await import('../../../electron/shared/i18n-locales/zh');
    const { ko } = await import('../../../electron/shared/i18n-locales/ko');
    for (const cat of [en, zh, ko] as Array<Record<string, string>>) {
      expect(cat['panels.terminal.kill_confirm.title']).toBeTruthy();
      expect(cat['panels.terminal.kill_confirm.detail']).toContain('{process}');
      expect(cat['panels.terminal.kill_confirm.confirm']).toBeTruthy();
    }
  });
});
