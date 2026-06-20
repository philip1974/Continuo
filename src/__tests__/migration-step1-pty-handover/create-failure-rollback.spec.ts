import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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


describe('migration step1 PTY handover · create failure rollback', () => {
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
    sessionManagerMock.getBufferSnapshot.mockReset().mockImplementation(() => {
      const err = new Error('Session not found') as Error & { code: string };
      err.code = 'SESSION_NOT_FOUND';
      throw err;
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

  it('rolls back local maps, buffer, interval, shell cleanup, and token on sm.create reject', async () => {
    const win = makeWindow(8);
    sessionManagerMock.create.mockRejectedValueOnce(new Error('boot fail'));

    await expect(
      terminalService.createTerminal('rollback', win, '/bin/zsh', [], '/tmp', undefined, {
        mcpToken: 'token-rollback',
      }),
    ).rejects.toThrow('boot fail');

    expect(terminalService.has('rollback')).toBe(false);
    expect(terminalService.getBufferSnapshot('rollback')).toEqual({
      data: '',
      truncated: false,
    });
    expect(shellMock.cleanup).toHaveBeenCalledOnce();
    expect(byToken).toHaveBeenCalledWith('token-rollback');

    sessionManagerMock.options?.onData?.('rollback', 'late-data');
    vi.advanceTimersByTime(32);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  // topic 49 第十九轮 P2-AW:prepareShellIntegrationEnv 在 PHASE 1 try 之外失败时,
  // 已签发的 mcpToken 也要撤销(否则孤儿 token 留在 windowTokens 泄漏)。
  it('revokes mcpToken when prepareShellIntegrationEnv rejects (pre-PHASE1 failure)', async () => {
    const win = makeWindow(9);
    shellMock.prepareShellIntegrationEnv.mockRejectedValueOnce(
      new Error('ENOSPC writing shell integration'),
    );

    await expect(
      terminalService.createTerminal('prep-fail', win, '/bin/zsh', [], '/tmp', undefined, {
        mcpToken: 'token-prep',
      }),
    ).rejects.toThrow('ENOSPC');

    // token 被撤销,且没有残留 instance(PHASE 1 从未执行到)
    expect(byToken).toHaveBeenCalledWith('token-prep');
    expect(terminalService.has('prep-fail')).toBe(false);
    // sm.create 从未被调用(失败发生在它之前)
    expect(sessionManagerMock.create).not.toHaveBeenCalled();
  });
});
