import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
import { setMcpRevokers } from '../../../electron/main/services/mcp-host.service';


describe('migration step1 PTY handover · forceKill cleanup', () => {
  const byToken = vi.fn();
  const byWindow = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    terminalService.__resetForTest();
    terminalSessions._reset();
    setMcpRevokers({ byToken, byWindow });
    byToken.mockReset();
    byWindow.mockReset();
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

  it('cleanupAll 不通过 id 中间数组 .map 调度强杀,且仍清理所有会话', async () => {
    const win = makeWindow(8);
    for (const id of ['a', 'b', 'c']) {
      await terminalService.createTerminal(id, win, '/bin/zsh', [], '/tmp');
      terminalSessions.add({
        id,
        title: id,
        cwd: '/tmp',
        originHint: 'user',
        ownerWindowId: 8,
      });
    }

    const mapSpy = vi.spyOn(Array.prototype, 'map');
    try {
      await terminalService.cleanupAll();
      const mappedIdArray = mapSpy.mock.instances.some(
        (inst) =>
          Array.isArray(inst) &&
          inst.length === 3 &&
          inst.every((id) => typeof id === 'string'),
      );
      expect(mappedIdArray).toBe(false);
    } finally {
      mapSpy.mockRestore();
    }

    expect(sessionManagerMock.kill).toHaveBeenCalledTimes(3);
    expect(sessionManagerMock.kill).toHaveBeenCalledWith({
      session_id: 'a',
      signal: 'SIGKILL',
    });
    expect(sessionManagerMock.kill).toHaveBeenCalledWith({
      session_id: 'b',
      signal: 'SIGKILL',
    });
    expect(sessionManagerMock.kill).toHaveBeenCalledWith({
      session_id: 'c',
      signal: 'SIGKILL',
    });
    expect(terminalService.has('a')).toBe(false);
    expect(terminalService.has('b')).toBe(false);
    expect(terminalService.has('c')).toBe(false);
  });

  it('cleanupAll 预分配 kill promise 数组,不通过 kills.push 扩容', () => {
    const src = readFileSync(
      path.join(process.cwd(), 'electron/main/services/terminal.service.ts'),
      'utf-8',
    );
    expect(src).toMatch(/new Array<Promise<void>>\(instances\.size\)/);
    expect(src).not.toMatch(/kills\.push\(/);
  });
});
