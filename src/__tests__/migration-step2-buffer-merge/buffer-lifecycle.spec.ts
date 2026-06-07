import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

const killedIds = vi.hoisted(() => new Set<string>());
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
  kill: vi.fn(async (input: { session_id: string }) => {
    killedIds.add(input.session_id);
    return {};
  }),
  getBufferSnapshot: vi.fn((id: string) => {
    if (killedIds.has(id)) {
      const err = new Error('Session not found') as Error & { code: string };
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }
    return { data: `live:${id}`, nextSeq: 1, truncated: false };
  }),
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
    return sessionManagerMock;
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

import * as service from '../../../electron/main/services/terminal.service';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';
import { makeWindowClosedCleanup } from '../../../electron/main/ipc/terminal.ipc';
import { setMcpRevokers } from '../../../electron/main/services/mcp-host.service';


function addSession(id: string, ownerWindowId: number): void {
  terminalSessions.add({
    id,
    title: id,
    cwd: '/tmp',
    originHint: 'user',
    ownerWindowId,
  });
}

describe('migration step2 buffer merge · buffer lifecycle', () => {
  const byToken = vi.fn();
  const byWindow = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    service.__resetForTest();
    terminalSessions._reset();
    setMcpRevokers({ byToken, byWindow });
    killedIds.clear();
    sessionManagerMock.options = undefined;
    sessionManagerMock.create.mockReset().mockResolvedValue({ session_id: 'created' });
    sessionManagerMock.sendInput.mockReset().mockResolvedValue({});
    sessionManagerMock.resize.mockReset().mockResolvedValue(undefined);
    sessionManagerMock.kill.mockClear();
    sessionManagerMock.getBufferSnapshot.mockClear();
    sessionManagerMock.readOutput.mockReset().mockResolvedValue({
      lines: [],
      next_seq: 1,
      truncated: false,
    });
    shellMock.cleanup.mockReset().mockResolvedValue(undefined);
    shellMock.prepareShellIntegrationEnv.mockClear();
    byToken.mockReset();
    byWindow.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('T4 forceKill releases replay buffer through SessionManager removal', async () => {
    const win = makeWindow(1);
    await service.createTerminal('live-kill', win, '/bin/zsh', [], '/tmp');
    addSession('live-kill', 1);

    expect(service.getBufferSnapshot('live-kill')).toEqual({
      data: 'live:live-kill',
      truncated: false,
    });

    service.forceKill('live-kill');

    expect(service.getBufferSnapshot('live-kill')).toEqual({
      data: '',
      truncated: false,
    });
  });

  it('T5 window close graceful path releases buffers after grace timer', async () => {
    const win = makeWindow(2, true);
    await service.createTerminal('window-kill', win, '/bin/zsh', [], '/tmp');
    addSession('window-kill', 2);

    makeWindowClosedCleanup()(2);
    expect(sessionManagerMock.sendInput).toHaveBeenCalledWith({
      session_id: 'window-kill',
      data: '\x03',
    });

    vi.advanceTimersByTime(3_000);

    expect(service.getBufferSnapshot('window-kill')).toEqual({
      data: '',
      truncated: false,
    });
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
