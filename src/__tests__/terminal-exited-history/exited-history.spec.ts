import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

const sm = vi.hoisted(() => ({
  options: undefined as
    | {
        onData?: (sessionId: string, chunk: string) => void;
        onExit?: (sessionId: string, info: { exitCode: number }) => void;
      }
    | undefined,
  live: new Map<string, string>(),
}));

vi.mock('@continuo-terminal/server-node', async () => ({
  ...(await vi.importActual<typeof import('@continuo-terminal/server-node')>(
    '@continuo-terminal/server-node',
  )),
  SessionManager: vi.fn().mockImplementation((options) => {
    sm.options = options;
    return {
      create: vi.fn(async ({ session_id }: { session_id: string }) => {
        sm.live.set(session_id, '');
        return { session_id };
      }),
      sendInput: vi.fn(async () => ({})),
      kill: vi.fn(async ({ session_id }: { session_id: string }) => {
        sm.live.delete(session_id);
        return {};
      }),
      getBufferSnapshot: vi.fn((id: string) => {
        if (!sm.live.has(id)) {
          throw Object.assign(new Error('not found'), { code: 'SESSION_NOT_FOUND' });
        }
        return { data: sm.live.get(id)!, nextSeq: 1, truncated: false };
      }),
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

async function open(id: string, output: string) {
  terminalSessions.add({ id, title: id, cwd: '/tmp', originHint: 'agent', ownerWindowId: 1 });
  await terminalService.createTerminal(id, makeWindow(1), '/bin/zsh', [], '/tmp');
  sm.live.set(id, output);
}

/** 模拟 server-node:onExit 回调之后才 removeSession(删 ring buffer)。 */
function naturalExit(id: string) {
  sm.options?.onExit?.(id, { exitCode: 0 });
  sm.live.delete(id);
}

describe('terminal exited history · 退出后 tab 仍可回放', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalService.__resetForTest();
    terminalSessions._reset();
    sm.live.clear();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('自然退出后仍返回退出前的输出,带退出时的 endOffset', async () => {
    await open('a', 'build ok\r\n');
    sm.options?.onData?.('a', 'build ok\r\n');
    naturalExit('a');
    expect(terminalService.getBufferSnapshot('a')).toEqual({
      data: 'build ok\r\n',
      truncated: false,
      endOffset: 10,
      startOffset: 0,
    });
  });

  it('forceKill 后同样保留', async () => {
    await open('a', 'partial');
    terminalService.forceKill('a');
    await Promise.resolve();
    expect(sm.live.has('a')).toBe(false);
    expect(terminalService.getBufferSnapshot('a').data).toBe('partial');
  });

  it('关 tab(metadata 删除)→ 释放快照', async () => {
    await open('a', 'out');
    naturalExit('a');
    terminalSessions.remove('a');
    expect(terminalService.getBufferSnapshot('a')).toEqual({ data: '', truncated: false });
  });

  it('metadata 先删再 kill(关 tab 触发)→ 不保留', async () => {
    await open('a', 'out');
    terminalSessions.remove('a');
    terminalService.forceKill('a');
    expect(terminalService.getBufferSnapshot('a')).toEqual({ data: '', truncated: false });
  });

  it('保留数量有上限,最旧的先淘汰', async () => {
    const n = terminalService.MAX_EXITED_HISTORIES_FOR_TEST;
    for (let i = 0; i <= n; i++) {
      await open(`s${i}`, `out${i}`);
      naturalExit(`s${i}`);
    }
    expect(terminalService.getBufferSnapshot('s0').data).toBe('');
    expect(terminalService.getBufferSnapshot(`s${n}`).data).toBe(`out${n}`);
  });
});
