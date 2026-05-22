import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const sessionManagerMock = vi.hoisted(() => ({
  options: undefined as
    | {
        onData?: (sessionId: string, chunk: string) => void;
        onExit?: (sessionId: string, info: { exitCode: number; signal?: number }) => void;
      }
    | undefined,
  create: vi.fn(),
  sendInput: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  cleanup: vi.fn(async () => {}),
  prepareEnv: vi.fn(async (_shell: string, env: Record<string, string | undefined>) => ({
    env,
    cleanup: shellMock.cleanup,
  })),
}));

vi.mock('@continuo-terminal/server-node', () => ({
  SessionManager: vi.fn().mockImplementation((options) => {
    sessionManagerMock.options = options;
    return {
      create: sessionManagerMock.create,
      sendInput: sessionManagerMock.sendInput,
      resize: sessionManagerMock.resize,
      kill: sessionManagerMock.kill,
    };
  }),
}));

vi.mock('../../../electron/main/services/shell-integration', () => ({
  prepareEnv: shellMock.prepareEnv,
}));

vi.mock('../../../electron/main/services/settings.service', () => ({
  getCurrentLocale: vi.fn(() => 'en'),
}));

vi.mock('../../../electron/main/services/pty-lang', () => ({
  withPtyLangEnv: vi.fn((env) => env),
}));

import * as terminalService from '../../../electron/main/services/terminal.service';
import * as terminalBuffer from '../../../electron/main/services/terminal-buffer.service';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';
import { setMcpRevokers } from '../../../electron/main/services/mcp-host.service';

function makeWindow(id: number, destroyed = false): BrowserWindow {
  const webContents = {
    send: vi.fn(),
    isDestroyed: vi.fn(() => destroyed),
  };
  return {
    id,
    isDestroyed: vi.fn(() => destroyed),
    webContents,
  } as unknown as BrowserWindow;
}

describe('migration step1 PTY handover · forceKill cleanup', () => {
  const byToken = vi.fn();
  const byWindow = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    terminalService.__resetForTest();
    terminalBuffer._resetForTest();
    terminalSessions._reset();
    setMcpRevokers({ byToken, byWindow });
    byToken.mockReset();
    byWindow.mockReset();
    sessionManagerMock.options = undefined;
    sessionManagerMock.create.mockReset().mockResolvedValue({ session_id: 'created' });
    sessionManagerMock.sendInput.mockReset().mockResolvedValue({});
    sessionManagerMock.resize.mockReset().mockResolvedValue(undefined);
    sessionManagerMock.kill.mockReset().mockResolvedValue({});
    shellMock.cleanup.mockReset().mockResolvedValue(undefined);
    shellMock.prepareEnv.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('cleans local state synchronously before SessionManager onExit can fire', async () => {
    const win = makeWindow(7);
    await terminalService.createTerminal('k', win, '/bin/zsh', [], '/tmp', undefined, {
      mcpToken: 'token-k',
    });
    terminalSessions.add({
      id: 'k',
      title: 'Terminal',
      cwd: '/tmp',
      originHint: 'user',
      ownerWindowId: 7,
    });

    const setExitedSpy = vi.spyOn(terminalSessions, 'setExited');

    terminalService.forceKill('k');

    expect(setExitedSpy).toHaveBeenCalledWith('k', -1);
    expect(win.webContents.send).toHaveBeenCalledWith('terminal:exit', 'k', {
      exitCode: -1,
      signal: undefined,
    });
    expect(byToken).toHaveBeenCalledWith('token-k');
    expect(terminalService.has('k')).toBe(false);
    expect(sessionManagerMock.kill).toHaveBeenCalledWith({
      session_id: 'k',
      signal: 'SIGKILL',
    });

    expect(() => {
      sessionManagerMock.options?.onExit?.('k', { exitCode: 137, signal: 9 });
    }).not.toThrow();
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
  });
});
