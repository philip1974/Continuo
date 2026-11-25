// BDD: terminal-title / 2-5 main 侧:会话动态标题字段、重命名 / OSC 标题 IPC、输出后节流刷新前台进程名、renderer ingress
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

const sm = vi.hoisted(() => ({
  options: undefined as { onData?: (id: string, chunk: string) => void } | undefined,
  // 与 server-node SessionManager 的私有字段同形:sessions Map → { pty }
  sessions: new Map<string, { pty: { process: string } }>(),
}));

vi.mock('@continuo-terminal/server-node', async () => ({
  ...(await vi.importActual<typeof import('@continuo-terminal/server-node')>('@continuo-terminal/server-node')),
  SessionManager: vi.fn().mockImplementation((options) => {
    sm.options = options;
    return {
      sessions: sm.sessions,
      create: vi.fn(async ({ session_id }: { session_id: string }) => ({ session_id })),
      kill: vi.fn(async () => ({})),
    };
  }),
  prepareShellIntegrationEnv: vi.fn(async (_shell: string, env: Record<string, string>) => ({ env, cleanup: async () => {} })),
}));
vi.mock('electron', () => ({ app: { getPath: vi.fn((k: string) => `/tmp/test-${k}`) }, BrowserWindow: {} }));
vi.mock('../../../electron/main/services/settings.service', () => ({ getCurrentLocale: vi.fn(() => 'en') }));
vi.mock('../../../electron/main/services/pty-lang', () => ({ withPtyLangEnv: vi.fn((env) => env) }));

import * as terminalService from '../../../electron/main/services/terminal.service';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';
import {
  makeRenameHandler,
  makeUpdateTitleHandler,
  titleInputSchema,
} from '../../../electron/main/ipc/terminal.ipc';
import { TERMINAL_CHANNELS } from '../../../electron/shared/terminal-channels';
import { LABEL_MAX } from '../../../electron/shared/terminal-create';
import { filterByOwnerWindow } from '@/stores/terminal.store';

const get = (id: string) => terminalSessions.get(id)!;

beforeEach(() => {
  terminalService.__resetForTest();
  terminalSessions._reset();
  sm.sessions.clear();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('会话动态标题字段', () => {
  it('设置 / 改值广播;同值不广播;空串或 undefined 清除字段', () => {
    terminalSessions.add({ id: 't', title: 'Terminal 1', defaultTitleIndex: 1, cwd: '/w', originHint: 'user', ownerWindowId: 1 });
    const seen = vi.fn();
    terminalSessions.subscribe(seen);
    terminalSessions.setTitleField('t', 'sequenceTitle', 'A');
    terminalSessions.setTitleField('t', 'sequenceTitle', 'A');
    expect(seen).toHaveBeenCalledTimes(1);
    expect(get('t').sequenceTitle).toBe('A');
    terminalSessions.setTitleField('t', 'sequenceTitle', '');
    expect('sequenceTitle' in get('t')).toBe(false);
    terminalSessions.setTitleField('t', 'userTitle', 'U');
    terminalSessions.setTitleField('t', 'userTitle', undefined);
    expect('userTitle' in get('t')).toBe(false);
    // 不动其它字段(默认名序号保留,清除重命名后回到「终端 N」)
    expect(get('t').defaultTitleIndex).toBe(1);
    terminalSessions.setTitleField('missing', 'userTitle', 'x'); // 未知会话 no-op
  });
});

describe('重命名 / OSC 标题 IPC', () => {
  beforeEach(() => {
    terminalSessions.add({ id: 't', title: 'Terminal 1', cwd: '/w', originHint: 'user', ownerWindowId: 1 });
  });
  it('通道名在 terminal: 前缀族内', () => {
    expect(TERMINAL_CHANNELS.RENAME).toBe('terminal:rename');
    expect(TERMINAL_CHANNELS.UPDATE_TITLE).toBe('terminal:update_title');
  });
  it('重命名:去首尾空白后固定;留空(含全空白)清除', () => {
    const rename = makeRenameHandler();
    rename({ id: 't', title: '  构建  ' }, makeWindow(1));
    expect(get('t').userTitle).toBe('构建');
    rename({ id: 't', title: '   ' }, makeWindow(1));
    expect(get('t').userTitle).toBeUndefined();
  });
  it('OSC 标题原样存(空 → 清除)', () => {
    const update = makeUpdateTitleHandler();
    update({ id: 't', title: ' MYTITLE ' }, makeWindow(1));
    expect(get('t').sequenceTitle).toBe(' MYTITLE ');
    update({ id: 't', title: '' }, makeWindow(1));
    expect(get('t').sequenceTitle).toBeUndefined();
  });
  it('只允许本窗口的会话;标题长度封顶 LABEL_MAX', () => {
    expect(() => makeRenameHandler()({ id: 't', title: 'x' }, makeWindow(2))).toThrow(/not found/);
    expect(() => makeUpdateTitleHandler()({ id: 't', title: 'x' }, makeWindow(2))).toThrow(/not found/);
    expect(get('t').userTitle).toBeUndefined();
    expect(titleInputSchema.safeParse({ id: 't', title: 'x'.repeat(LABEL_MAX) }).success).toBe(true);
    expect(titleInputSchema.safeParse({ id: 't', title: 'x'.repeat(LABEL_MAX + 1) }).success).toBe(false);
  });
});

describe('输出后节流刷新前台进程名', () => {
  async function open(foreground: string) {
    vi.useFakeTimers();
    terminalSessions.add({ id: 'a', title: 'a', cwd: '/tmp', originHint: 'user', ownerWindowId: 1 });
    await terminalService.createTerminal('a', makeWindow(1), '/bin/zsh', [], '/tmp');
    sm.sessions.set('a', { pty: { process: foreground } });
  }
  const emit = (chunk: string) => sm.options?.onData?.('a', chunk);

  it('输出后 PROCESS_TITLE_REFRESH_MS 读前台进程名;shell 本身 → 无;程序结束 → 清除', async () => {
    await open('zsh');
    emit('$ ');
    vi.advanceTimersByTime(5 + terminalService.PROCESS_TITLE_REFRESH_MS);
    expect(get('a').processName).toBeUndefined();

    sm.sessions.get('a')!.pty.process = 'vim';
    emit('\r\n');
    vi.advanceTimersByTime(5);
    expect(get('a').processName).toBeUndefined(); // 尚未到刷新时刻
    vi.advanceTimersByTime(terminalService.PROCESS_TITLE_REFRESH_MS);
    expect(get('a').processName).toBe('vim');

    sm.sessions.get('a')!.pty.process = 'zsh';
    emit('$ ');
    vi.advanceTimersByTime(5 + terminalService.PROCESS_TITLE_REFRESH_MS);
    expect(get('a').processName).toBeUndefined();
  });

  it('持续输出时节流(每个刷新窗口至多读一次),空闲不留定时器', async () => {
    await open('node');
    let reads = 0;
    sm.sessions.set('a', {
      pty: {
        get process() {
          reads += 1;
          return 'node';
        },
        set process(_v: string) {},
      },
    });
    for (let i = 0; i < 40; i += 1) {
      emit(`line ${i}\n`);
      vi.advanceTimersByTime(10); // 400ms 持续输出
    }
    vi.advanceTimersByTime(terminalService.PROCESS_TITLE_REFRESH_MS);
    expect(get('a').processName).toBe('node');
    expect(reads).toBeLessThanOrEqual(3); // 400ms / 200ms + 尾随一次,而不是每批一次(40)
    expect(vi.getTimerCount()).toBe(0);
  });

  it('进程退出 → 前台程序名清除', async () => {
    await open('vim');
    emit('x');
    vi.advanceTimersByTime(5 + terminalService.PROCESS_TITLE_REFRESH_MS);
    expect(get('a').processName).toBe('vim');
    terminalService.forceKill('a');
    expect(get('a').processName).toBeUndefined();
    expect(get('a').exitCode).not.toBeNull();
  });
});

describe('renderer ingress 校验动态标题字段', () => {
  const snap = (extra: Record<string, unknown>) => ({
    id: 't',
    title: 'Terminal 1',
    cwd: '/w',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ownerWindowId: 1,
    ...extra,
  });
  it('≤ LABEL_MAX 的字符串放行,超长 / 非字符串丢弃', () => {
    expect(filterByOwnerWindow([snap({ userTitle: 'u', processName: 'vim', sequenceTitle: 's' })], 1)).toHaveLength(1);
    expect(filterByOwnerWindow([snap({ sequenceTitle: 'x'.repeat(LABEL_MAX + 1) })], 1)).toHaveLength(0);
    expect(filterByOwnerWindow([snap({ processName: 42 })], 1)).toHaveLength(0);
    expect(filterByOwnerWindow([snap({ userTitle: null })], 1)).toHaveLength(0);
  });
});
