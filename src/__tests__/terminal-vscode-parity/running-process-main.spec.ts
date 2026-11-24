// BDD: terminal-vscode-parity / 4 main 侧判定「终端里有正在运行的子程序」(node-pty 前台进程名 vs shell 名)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

const sm = vi.hoisted(() => ({
  // 与 server-node SessionManager 的私有字段同形:sessions Map → { pty }
  sessions: new Map<string, { pty: { readonly process: string } }>(),
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

import * as terminalService from '../../../electron/main/services/terminal.service';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';
import { makeRunningProcessHandler } from '../../../electron/main/ipc/terminal.ipc';

async function open(id: string, foreground: string, ownerWindowId = 1) {
  terminalSessions.add({ id, title: id, cwd: '/tmp', originHint: 'user', ownerWindowId });
  await terminalService.createTerminal(id, makeWindow(ownerWindowId), '/bin/zsh', [], '/tmp');
  sm.sessions.set(id, { pty: { process: foreground } });
}

describe('runningChildProcess', () => {
  beforeEach(() => {
    terminalService.__resetForTest();
    terminalSessions._reset();
    sm.sessions.clear();
  });
  afterEach(() => vi.clearAllMocks());

  it('前台是 shell 本身 → null;前台是其它程序 → 返回其名', async () => {
    await open('idle', 'zsh');
    await open('busy', 'sleep');
    expect(terminalService.runningChildProcess('idle')).toBeNull();
    expect(terminalService.runningChildProcess('busy')).toBe('sleep');
  });
  it('无实例(已退出 / 未知 id)或取进程名抛错 → null', async () => {
    expect(terminalService.runningChildProcess('nope')).toBeNull();
    await open('broken', 'zsh');
    sm.sessions.set('broken', {
      pty: {
        get process(): string {
          throw new Error('EBADF');
        },
      },
    });
    expect(terminalService.runningChildProcess('broken')).toBeNull();
  });
  it('IPC handler:只允许本窗口的会话,返回 { process }', async () => {
    await open('busy', 'vim', 1);
    const handler = makeRunningProcessHandler();
    expect(handler({ id: 'busy' }, makeWindow(1) as never)).toEqual({ process: 'vim' });
    expect(() => handler({ id: 'busy' }, makeWindow(2) as never)).toThrow(/not found/);
  });
});
