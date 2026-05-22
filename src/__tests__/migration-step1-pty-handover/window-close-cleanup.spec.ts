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
import { makeWindowClosedCleanup } from '../../../electron/main/ipc/terminal.ipc';
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

function addSession(id: string, ownerWindowId: number): void {
  terminalSessions.add({
    id,
    title: id,
    cwd: '/tmp',
    originHint: 'user',
    ownerWindowId,
  });
}

describe('migration step1 PTY handover · window close cleanup', () => {
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

  it('keeps baseline graceful close order and does not send to destroyed WebContents', async () => {
    const winA = makeWindow(1, true);
    const winB = makeWindow(2, false);

    for (const id of ['a1', 'a2', 'a3']) {
      await terminalService.createTerminal(id, winA, '/bin/zsh', [], '/tmp');
      addSession(id, 1);
    }
    for (const id of ['b1', 'b2']) {
      await terminalService.createTerminal(id, winB, '/bin/zsh', [], '/tmp');
      addSession(id, 2);
    }

    makeWindowClosedCleanup()(1);

    expect(byWindow).toHaveBeenCalledWith(1);
    expect(sessionManagerMock.sendInput).toHaveBeenCalledWith({
      session_id: 'a1',
      data: '\x03',
    });
    expect(sessionManagerMock.sendInput).toHaveBeenCalledWith({
      session_id: 'a2',
      data: '\x03',
    });
    expect(sessionManagerMock.sendInput).toHaveBeenCalledWith({
      session_id: 'a3',
      data: '\x03',
    });

    vi.advanceTimersByTime(3_000);

    expect(sessionManagerMock.kill).toHaveBeenCalledTimes(3);
    expect(winA.webContents.send).not.toHaveBeenCalled();
    expect(terminalService.has('b1')).toBe(true);
    expect(terminalService.has('b2')).toBe(true);
    expect(terminalSessions.getAll({ ownerWindowId: 2 }).map((s) => s.id)).toEqual([
      'b1',
      'b2',
    ]);
  });
});
