import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

const sessionManagerMock = vi.hoisted(() => ({
  options: undefined as
    | { onData?: (sessionId: string, chunk: string) => void }
    | undefined,
  create: vi.fn(),
  getBufferSnapshot: vi.fn(),
}));

vi.mock('@continuo-terminal/server-node', async () => ({
  ...(await vi.importActual<typeof import('@continuo-terminal/server-node')>(
    '@continuo-terminal/server-node',
  )),
  SessionManager: vi.fn().mockImplementation((options) => {
    sessionManagerMock.options = options;
    return {
      create: sessionManagerMock.create,
      getBufferSnapshot: sessionManagerMock.getBufferSnapshot,
      kill: vi.fn(async () => ({})),
    };
  }),
  prepareShellIntegrationEnv: vi.fn(async (_shell: string, env: Record<string, string>) => ({
    env,
    cleanup: async () => {},
  })),
}));
vi.mock('electron', () => ({
  app: { getPath: vi.fn((key: string) => `/tmp/test-${key}`) },
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

const emit = (chunk: string) => sessionManagerMock.options?.onData?.('a', chunk);

describe('terminal history replay · 主进程偏移坐标', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalService.__resetForTest();
    terminalSessions._reset();
    sessionManagerMock.create.mockReset().mockResolvedValue({ session_id: 'a' });
    sessionManagerMock.getBufferSnapshot.mockReset().mockReturnValue({
      data: 'abcdef',
      nextSeq: 3,
      truncated: false,
    });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('推送带本批首字符的累计偏移', async () => {
    const win = makeWindow(1);
    await terminalService.createTerminal('a', win, '/bin/zsh', [], '/tmp');
    emit('abc');
    vi.advanceTimersByTime(20);
    emit('de');
    emit('f');
    vi.advanceTimersByTime(20);
    expect(win.webContents.send).toHaveBeenNthCalledWith(1, 'terminal:data', 'a', 'abc', 0);
    expect(win.webContents.send).toHaveBeenNthCalledWith(2, 'terminal:data', 'a', 'def', 3);
  });

  it('取快照前先发出在途批次,返回 endOffset;之后的推送偏移 ≥ endOffset', async () => {
    const win = makeWindow(1);
    await terminalService.createTerminal('a', win, '/bin/zsh', [], '/tmp');
    emit('abc');
    vi.advanceTimersByTime(20);
    emit('def'); // 仍在合批窗口内,未发出

    const snap = terminalService.getBufferSnapshot('a');
    expect(snap).toEqual({ data: 'abcdef', truncated: false, endOffset: 6, startOffset: 0 });
    // 在途批次已在取快照之前同步发出(偏移 3 < endOffset)
    expect(win.webContents.send).toHaveBeenLastCalledWith('terminal:data', 'a', 'def', 3);

    emit('g');
    vi.advanceTimersByTime(20);
    expect(win.webContents.send).toHaveBeenLastCalledWith('terminal:data', 'a', 'g', 6);
    // 在途批次的定时器已撤销,不会重复发送
    expect(win.webContents.send).toHaveBeenCalledTimes(3);
  });

  it('ring buffer 挤掉最旧数据后,startOffset = 快照首字符偏移', async () => {
    const win = makeWindow(1);
    await terminalService.createTerminal('a', win, '/bin/zsh', [], '/tmp');
    emit('0123456789');
    sessionManagerMock.getBufferSnapshot.mockReturnValue({ data: '6789', nextSeq: 2, truncated: true });
    // 截断时前置的 '\x1b[0m' 不计入坐标
    expect(terminalService.getBufferSnapshot('a')).toEqual({
      data: '\x1b[0m6789',
      truncated: true,
      endOffset: 10,
      startOffset: 6,
    });
  });

  it('overflow 截断批次的偏移 = 保留尾部的起点', async () => {
    const win = makeWindow(1);
    await terminalService.createTerminal('a', win, '/bin/zsh', [], '/tmp');
    const big = 'x'.repeat(3 * 1024 * 1024); // > 2MB/s 触发 overflow + 截断到 64KB
    emit(big);
    vi.advanceTimersByTime(200);
    const call = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'terminal:data',
    )!;
    const [, , data, offset] = call as [string, string, string, number];
    expect(data.startsWith('\x1b[0m')).toBe(true);
    expect(offset).toBe(big.length - (data.length - 4));
  });

  it('会话不存在 → 无 endOffset', () => {
    const err = Object.assign(new Error('nope'), { code: 'SESSION_NOT_FOUND' });
    sessionManagerMock.getBufferSnapshot.mockImplementation(() => {
      throw err;
    });
    expect(terminalService.getBufferSnapshot('missing')).toEqual({ data: '', truncated: false });
  });
});
