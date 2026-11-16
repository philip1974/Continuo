import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

const sessionManagerMock = vi.hoisted(() => ({
  options: undefined as
    | { onData?: (sessionId: string, chunk: string) => void }
    | undefined,
  create: vi.fn(),
}));

vi.mock('@continuo-terminal/server-node', async () => ({
  ...(await vi.importActual<typeof import('@continuo-terminal/server-node')>(
    '@continuo-terminal/server-node',
  )),
  SessionManager: vi.fn().mockImplementation((options) => {
    sessionManagerMock.options = options;
    return { create: sessionManagerMock.create, kill: vi.fn(async () => ({})) };
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

describe('terminal output latency · 交互回显不被合批窗口拖慢', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalService.__resetForTest();
    terminalSessions._reset();
    sessionManagerMock.create.mockReset().mockResolvedValue({ session_id: 'a' });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('普通回显字符 ≤5ms 送达', async () => {
    const win = makeWindow(1);
    await terminalService.createTerminal('a', win, '/bin/zsh', [], '/tmp');
    sessionManagerMock.options?.onData?.('a', 'l');
    vi.advanceTimersByTime(5);
    expect(win.webContents.send).toHaveBeenCalledWith('terminal:data', 'a', 'l', 0);
  });

  it('行编辑器回显(带清行 / 光标移动 CSI)同样 ≤5ms 送达', async () => {
    const win = makeWindow(1);
    await terminalService.createTerminal('a', win, '/bin/zsh', [], '/tmp');
    const echo = 'ls\x1b[K\x1b[1D';
    sessionManagerMock.options?.onData?.('a', echo);
    vi.advanceTimersByTime(5);
    expect(win.webContents.send).toHaveBeenCalledWith('terminal:data', 'a', echo, 0);
  });

  it('同一窗口内的多个 chunk 合并为一次发送', async () => {
    const win = makeWindow(1);
    await terminalService.createTerminal('a', win, '/bin/zsh', [], '/tmp');
    sessionManagerMock.options?.onData?.('a', 'foo');
    sessionManagerMock.options?.onData?.('a', 'bar');
    vi.advanceTimersByTime(5);
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith('terminal:data', 'a', 'foobar', 0);
  });
});
