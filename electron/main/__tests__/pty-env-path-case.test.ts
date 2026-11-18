// Windows env 键大小写不敏感:宿主 `{...process.env}` 带 `PATH`(或 `Path`)、调用方 env 传另一种大小写时,
// 普通展开会两键并存。node-pty 按插入顺序把键值对写进环境块,子进程取到的是宿主键 → 调用方的覆盖失效。
// 契约:PTY env 合并在 Windows 上大小写不敏感(后者覆盖前者,只留一个键);非 Windows 与普通展开一致。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sm = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@continuo-terminal/server-node', async () => ({
  ...(await vi.importActual<typeof import('@continuo-terminal/server-node')>('@continuo-terminal/server-node')),
  SessionManager: vi.fn().mockImplementation(() => ({
    create: sm.create,
    sendInput: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue({}),
    getBufferSnapshot: vi.fn(),
    readOutput: vi.fn(),
  })),
  prepareShellIntegrationEnv: vi.fn(async (_shell: string, env: Record<string, string | undefined>) => ({
    env,
    args: [],
    cleanup: async () => {},
  })),
}));
vi.mock('electron', () => ({ app: { getPath: vi.fn((k: string) => `/tmp/test-${k}`) }, BrowserWindow: {} }));
vi.mock('../services/settings.service', () => ({ getCurrentLocale: vi.fn(() => 'en') }));
vi.mock('../services/pty-lang', () => ({ withPtyLangEnv: vi.fn((env: unknown) => env) }));

import type { BrowserWindow } from 'electron';
import * as terminalService from '../services/terminal.service';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const win = { id: 1, isDestroyed: () => false, webContents: { send: vi.fn(), isDestroyed: () => false } };

beforeEach(() => {
  terminalService.__resetForTest();
  sm.create.mockReset().mockResolvedValue({ session_id: 'x' });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  terminalService.__resetForTest();
});

function pathKeys(env: Record<string, string>): Array<[string, string]> {
  return Object.entries(env).filter(([k]) => k.toUpperCase() === 'PATH');
}

describe('PTY env 合并(Windows 键大小写不敏感)', () => {
  it('Windows:调用方 env 的 path 覆盖宿主 PATH,只留一个键', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    await terminalService.createTerminal('t1', win as unknown as BrowserWindow, '/bin/zsh', [], '/tmp', {
      path: 'C:\\plug',
    });
    const env = sm.create.mock.calls[0]![0].env as Record<string, string>;
    expect(pathKeys(env)).toEqual([['path', 'C:\\plug']]);
  });

  it('Windows:调用方 env 的大小写变体不能与内部会话键并存,内部值胜出', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    await terminalService.createTerminal('t3', win as unknown as BrowserWindow, '/bin/zsh', [], '/tmp', {
      continuo_terminal_session_id: 'other-session',
    });
    const env = sm.create.mock.calls[0]![0].env as Record<string, string>;
    expect(Object.entries(env).filter(([k]) => k.toUpperCase() === 'CONTINUO_TERMINAL_SESSION_ID')).toEqual([
      ['CONTINUO_TERMINAL_SESSION_ID', 't3'],
    ]);
  });

  it('非 Windows:大小写不同视为不同键(与普通展开一致)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    await terminalService.createTerminal('t2', win as unknown as BrowserWindow, '/bin/zsh', [], '/tmp', {
      path: 'x',
    });
    const env = sm.create.mock.calls[0]![0].env as Record<string, string>;
    expect(env.path).toBe('x');
    expect(env.PATH).toBe(process.env.PATH);
  });
});
