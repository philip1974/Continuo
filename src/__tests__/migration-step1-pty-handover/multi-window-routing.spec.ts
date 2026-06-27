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

  // race(R71):flush 闭包里 safeSend(target.send)抛错(窗口 isDestroyed 检查后销毁)若冒泡,
  // 会跳过 pendingData='' + flushTimer=null → 下个 chunk 因 flushTimer 非空不再调度 → 终端永久
  // 卡死;且 setTimeout 回调里成主进程未捕获异常。safeSend 须内部 try/catch。
  it('R71 flush 时 target.send 抛错 → 不卡死,后续 chunk 仍能调度送达', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = makeWindow(1);
    await terminalService.createTerminal('a', win, '/bin/zsh', [], '/tmp');

    // 第一次 flush:send 抛错(模拟 isDestroyed 检查后 webContents 销毁的竞态);仅这一次。
    (win.webContents.send as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('Object has been destroyed');
    });
    sessionManagerMock.options?.onData?.('a', 'chunk-1');
    // flush timer fire 时不应抛(setTimeout 回调安全;safeSend 内部 catch)。
    expect(() => vi.advanceTimersByTime(32)).not.toThrow();

    // 关键:safeSend 没冒泡 → flush 闭包继续执行清掉 pendingData='' + flushTimer=null。
    // 因此下一个 chunk 能重新 setTimeout 调度并送达(若 flushTimer 未清,则永久卡死收不到)。
    sessionManagerMock.options?.onData?.('a', 'chunk-2');
    vi.advanceTimersByTime(32);
    expect(win.webContents.send).toHaveBeenCalledWith('terminal:data', 'a', 'chunk-2');
  });

  // race(R96):service.resize 此前 fire-and-forget 恒 true,PTY resize 失败只 warn → renderer 无从
  // 感知 → DOM/PTY 尺寸长期不一致。改为等串行链中本次 resize 真实结果并上抛(true/false)。
  it('R96 service.resize 上抛真实结果:SessionManager.resize reject → false,成功 → true', async () => {
    const winA = makeWindow(1);
    await terminalService.createTerminal('a', winA, '/bin/zsh', [], '/tmp');

    sessionManagerMock.resize.mockReset().mockRejectedValueOnce(new Error('pty gone'));
    await expect(terminalService.resize('a', 80, 24)).resolves.toBe(false);

    sessionManagerMock.resize.mockReset().mockResolvedValue(undefined);
    await expect(terminalService.resize('a', 100, 30)).resolves.toBe(true);

    // 不存在的 session → false(不抛)。
    await expect(terminalService.resize('nope', 80, 24)).resolves.toBe(false);
  });
});
