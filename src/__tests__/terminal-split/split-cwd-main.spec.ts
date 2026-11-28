// BDD: terminal-split 5 —— main 端 terminal.cwd:shell 用 OSC 7 上报过 → 上报的目录;否则 shell 进程的真实当前目录
//(VSCode TerminalProcess.getCwd:mac lsof / Linux /proc/<pid>/cwd);取不到 → 会话初始目录。只查本窗口的会话。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

const sm = vi.hoisted(() => ({
  // 与 server-node SessionManager 的私有字段同形:sessions Map → { pty }
  sessions: new Map<string, { pty: { readonly pid: number; readonly process: string } }>(),
  readProcessCwd: vi.fn(async (_pid: number): Promise<string | null> => '/repo/sub/deeper'),
}));

vi.mock('@continuo-terminal/server-node', async () => ({
  ...(await vi.importActual<typeof import('@continuo-terminal/server-node')>('@continuo-terminal/server-node')),
  SessionManager: vi.fn().mockImplementation(() => ({
    sessions: sm.sessions,
    create: vi.fn(async ({ session_id }: { session_id: string }) => ({ session_id })),
    kill: vi.fn(async () => ({})),
  })),
  prepareShellIntegrationEnv: vi.fn(async (_shell: string, env: Record<string, string>) => ({ env, cleanup: async () => {} })),
}));
vi.mock('electron', () => ({ app: { getPath: vi.fn((k: string) => `/tmp/test-${k}`) }, BrowserWindow: {} }));
vi.mock('../../../electron/main/services/settings.service', () => ({ getCurrentLocale: vi.fn(() => 'en') }));
vi.mock('../../../electron/main/services/pty-lang', () => ({ withPtyLangEnv: vi.fn((env) => env) }));
vi.mock('../../../electron/main/services/terminal-process-cwd', () => ({ readProcessCwd: sm.readProcessCwd }));

import * as terminalService from '../../../electron/main/services/terminal.service';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';
import { makeCwdHandler, makeUpdateCwdHandler } from '../../../electron/main/ipc/terminal.ipc';

async function open(id: string, pid: number, ownerWindowId = 1) {
  terminalSessions.add({ id, title: id, cwd: '/repo', originHint: 'user', ownerWindowId });
  await terminalService.createTerminal(id, makeWindow(ownerWindowId), '/bin/zsh', [], '/repo');
  sm.sessions.set(id, { pty: { pid, process: 'zsh' } });
}

describe('terminal.cwd(拆分终端继承目录)', () => {
  beforeEach(() => {
    terminalService.__resetForTest();
    terminalSessions._reset();
    sm.sessions.clear();
    sm.readProcessCwd.mockImplementation(async () => '/repo/sub/deeper');
  });
  afterEach(() => vi.clearAllMocks());

  it('shell 未上报 OSC 7(macOS 默认 zsh):返回 shell 进程的真实当前目录(按 shell pid 查)', async () => {
    await open('a', 4242);
    expect(await makeCwdHandler()({ id: 'a' }, makeWindow(1) as never)).toEqual({ cwd: '/repo/sub/deeper' });
    expect(sm.readProcessCwd).toHaveBeenCalledWith(4242, undefined);
  });

  it('shell 用 OSC 7 上报过 → 以上报的目录为准,不再查进程', async () => {
    await open('a', 4242);
    makeUpdateCwdHandler()({ id: 'a', cwd: '/repo/osc7' }, makeWindow(1) as never);
    expect(await makeCwdHandler()({ id: 'a' }, makeWindow(1) as never)).toEqual({ cwd: '/repo/osc7' });
    expect(sm.readProcessCwd).not.toHaveBeenCalled();
  });

  it('进程目录取不到(Windows / lsof 失败 / 目录已删)→ 会话初始目录', async () => {
    await open('a', 4242);
    sm.readProcessCwd.mockResolvedValue(null);
    expect(await makeCwdHandler()({ id: 'a' }, makeWindow(1) as never)).toEqual({ cwd: '/repo' });
  });

  it('只查本窗口的会话:别的窗口 / 未知 id → not found,不查进程', async () => {
    await open('a', 4242, 1);
    await expect(makeCwdHandler()({ id: 'a' }, makeWindow(2) as never)).rejects.toThrow(/not found/);
    await expect(makeCwdHandler()({ id: 'nope' }, makeWindow(1) as never)).rejects.toThrow(/not found/);
    expect(sm.readProcessCwd).not.toHaveBeenCalled();
  });

  it('查询期间会话被关闭 → not found(不返回已关终端的目录)', async () => {
    await open('a', 4242);
    sm.readProcessCwd.mockImplementation(async () => {
      terminalSessions.remove('a');
      return '/repo/sub';
    });
    await expect(makeCwdHandler()({ id: 'a' }, makeWindow(1) as never)).rejects.toThrow(/not found/);
  });
});
