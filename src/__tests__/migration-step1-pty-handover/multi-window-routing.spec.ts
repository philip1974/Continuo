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

describe('migration step1 PTY handover · multi-window routing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalService.__resetForTest();
    terminalBuffer._resetForTest();
    terminalSessions._reset();
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

  it('routes chunks to the WebContents that owns the session id', async () => {
    const winA = makeWindow(1);
    const winB = makeWindow(2);

    await terminalService.createTerminal('a', winA, '/bin/zsh', [], '/tmp');
    await terminalService.createTerminal('b', winB, '/bin/zsh', [], '/tmp');

    sessionManagerMock.options?.onData?.('a', 'chunk-a');
    vi.advanceTimersByTime(32);

    expect(winA.webContents.send).toHaveBeenCalledWith('terminal:data', 'a', 'chunk-a');
    expect(winB.webContents.send).not.toHaveBeenCalled();

    sessionManagerMock.options?.onData?.('b', 'chunk-b');
    vi.advanceTimersByTime(32);

    expect(winB.webContents.send).toHaveBeenCalledWith('terminal:data', 'b', 'chunk-b');
    expect(winA.webContents.send).toHaveBeenCalledTimes(1);
  });
});
