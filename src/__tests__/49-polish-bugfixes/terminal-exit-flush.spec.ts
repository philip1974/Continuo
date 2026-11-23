// topic 49 · 审计 #1: 终端自然退出时,卡在节流窗口里的最后一段输出必须 flush 给 renderer
//(退出状态本身走 sessions 快照的 exitCode,没有单独的退出推送)。cleanupSessionLocal 旧实现直接 clearTimeout(flushTimer)
// 而不触发 flush → 命令最终结果 / exit banner 被丢弃。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

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
  kill: vi.fn(async () => ({})),
  getBufferSnapshot: vi.fn(() => ({ data: '', nextSeq: 1, truncated: false })),
  readOutput: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  cleanup: vi.fn(async () => {}),
  prepareShellIntegrationEnv: vi.fn(
    async (_shell: string, env: Record<string, string | undefined>) => ({
      env,
      args: [],
      cleanup: shellMock.cleanup,
    }),
  ),
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
  app: { getPath: vi.fn((key: string) => `/tmp/test-${key}`) },
  BrowserWindow: {},
}));

vi.mock('../../../electron/main/services/settings.service', () => ({
  getCurrentLocale: vi.fn(() => 'en'),
}));

vi.mock('../../../electron/main/services/pty-lang', () => ({
  withPtyLangEnv: vi.fn((env) => env),
}));

import * as service from '../../../electron/main/services/terminal.service';
import { setMcpRevokers } from '../../../electron/main/services/mcp-host.service';

describe('topic 49 · 终端退出 flush 最后输出', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    service.__resetForTest();
    setMcpRevokers({ byToken: vi.fn(), byWindow: vi.fn() });
    sessionManagerMock.options = undefined;
    sessionManagerMock.create.mockReset().mockResolvedValue({ session_id: 'created' });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('PTY 自然退出时,未 flush 的 pending 输出照常发出(不随退出丢弃)', async () => {
    const win = makeWindow(1);
    await service.createTerminal('s1', win, '/bin/zsh', [], '/tmp');

    // 一段输出进入节流窗口,但不推进定时器 → 仍卡在 pendingData
    sessionManagerMock.options?.onData?.('s1', 'final-output');
    expect(win.webContents.send).not.toHaveBeenCalled();

    // PTY 退出
    sessionManagerMock.options?.onExit?.('s1', { exitCode: 0 });

    const calls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    // 数据没丢
    expect(calls.some((c) => c[0] === 'terminal:data' && c[2] === 'final-output')).toBe(true);
  });

  it('退出时无 pending 输出则不发多余 terminal:data', async () => {
    const win = makeWindow(2);
    await service.createTerminal('s2', win, '/bin/zsh', [], '/tmp');

    sessionManagerMock.options?.onExit?.('s2', { exitCode: 0 });

    const calls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    // 退出本身不向 renderer 单独推送:退出状态走 sessions 快照的 exitCode。
    expect(calls).toEqual([]);
  });
});
