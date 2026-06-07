import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { makeWindow } from './fixtures';

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
  getBufferSnapshot: vi.fn(),
  readOutput: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  cleanup: vi.fn(async () => {}),
  prepareShellIntegrationEnv: vi.fn(async (_shell: string, env: Record<string, string | undefined>) => ({
    env,
    cleanup: shellMock.cleanup,
  })),
}));

vi.mock('@continuo-terminal/server-node', async () => ({
  ...(await vi.importActual<typeof import('@continuo-terminal/server-node')>(
    '@continuo-terminal/server-node',
  )),
  SessionManager: vi.fn().mockImplementation((options) => {
    sessionManagerMock.options = options;
    return {
      create: sessionManagerMock.create,
      sendInput: sessionManagerMock.sendInput,
      resize: sessionManagerMock.resize,
      kill: sessionManagerMock.kill,
      getBufferSnapshot: sessionManagerMock.getBufferSnapshot,
      readOutput: sessionManagerMock.readOutput,
    };
  }),
  prepareShellIntegrationEnv: shellMock.prepareShellIntegrationEnv,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => `/tmp/test-${key}`),
  },
  BrowserWindow: {},
}));

vi.mock('../../../electron/main/services/settings.service', () => ({
  getCurrentLocale: vi.fn(() => 'en'),
}));

vi.mock('../../../electron/main/services/pty-lang', () => ({
  withPtyLangEnv: vi.fn((env) => env),
}));

import * as terminalService from '../../../electron/main/services/terminal.service';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';


describe('migration step1 PTY handover · multi-window routing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalService.__resetForTest();
    terminalSessions._reset();
    sessionManagerMock.options = undefined;
    sessionManagerMock.create.mockReset().mockResolvedValue({ session_id: 'created' });
    sessionManagerMock.sendInput.mockReset().mockResolvedValue({});
    sessionManagerMock.resize.mockReset().mockResolvedValue(undefined);
    sessionManagerMock.kill.mockReset().mockResolvedValue({});
    sessionManagerMock.getBufferSnapshot.mockReset().mockReturnValue({
      data: '',
      nextSeq: 1,
      truncated: false,
    });
    sessionManagerMock.readOutput.mockReset().mockResolvedValue({
      lines: [],
      next_seq: 1,
      truncated: false,
    });
    shellMock.cleanup.mockReset().mockResolvedValue(undefined);
    shellMock.prepareShellIntegrationEnv.mockClear();
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
