// prepareShellIntegrationEnv 返回的 bash args(['--rcfile', <生成的 rc>, '-i'])是**非 login** 启动:
// 不读 /etc/profile(macOS path_helper 在此),且 rcfile 无条件依次 source .bash_profile/.profile/.bashrc
// → 重复执行、偏离原 `-l -i` 语义。故 Continuo 暂不采用 helper 的 bash args(待 helper 模拟 login
// 启动文件选择后再启用,见 doc/follow-ups.md):bash 仍 `-l -i`,用户 args 优先,zsh/fish 不变。
// 这里用真实 helper(不 mock),只 mock SessionManager 捕获最终 spawn 参数 / env。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

const sessionManagerMock = vi.hoisted(() => ({
  create: vi.fn(),
  sendInput: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(async () => ({})),
  getBufferSnapshot: vi.fn(() => ({ data: '', nextSeq: 1, truncated: false })),
  readOutput: vi.fn(),
}));

vi.mock('@continuo-terminal/server-node', async () => ({
  ...(await vi.importActual<typeof import('@continuo-terminal/server-node')>(
    '@continuo-terminal/server-node',
  )),
  SessionManager: vi.fn().mockImplementation(() => sessionManagerMock),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn((key: string) => `/tmp/test-${key}`) },
  BrowserWindow: {},
}));

vi.mock('../../../electron/main/services/settings.service', () => ({
  getCurrentLocale: vi.fn(() => 'en'),
}));

import * as service from '../../../electron/main/services/terminal.service';
import { setMcpRevokers } from '../../../electron/main/services/mcp-host.service';

function spawnedArgs(): string[] {
  const call = sessionManagerMock.create.mock.calls.at(-1);
  return (call?.[0] as { args: string[] }).args;
}

function spawnedEnv(): Record<string, string> {
  const call = sessionManagerMock.create.mock.calls.at(-1);
  return (call?.[0] as { env: Record<string, string> }).env;
}

describe('shell spawn args 约定(bash 不采用 helper args)', () => {
  beforeEach(() => {
    service.__resetForTest();
    setMcpRevokers({ byToken: vi.fn(), byWindow: vi.fn() });
    sessionManagerMock.create.mockReset().mockResolvedValue({ session_id: 'created' });
  });

  it('bash 且用户未传 args → 仍以 login+interactive(-l -i)启动,不用 helper 的 --rcfile', async () => {
    await service.createTerminal('b1', makeWindow(1), '/bin/bash', [], '/tmp');

    expect(spawnedArgs()).toEqual(['-l', '-i']);
    service.forceKill('b1');
  });

  it('bash 但用户显式传 args → 用户 args 优先', async () => {
    await service.createTerminal('b2', makeWindow(2), '/bin/bash', ['--norc'], '/tmp');

    expect(spawnedArgs()).toEqual(['--norc']);
    service.forceKill('b2');
  });

  it('zsh / fish → 仍用默认 login+interactive', async () => {
    await service.createTerminal('z1', makeWindow(3), '/bin/zsh', [], '/tmp');
    expect(spawnedArgs()).toEqual(['-l', '-i']);
    service.forceKill('z1');

    await service.createTerminal('f1', makeWindow(4), '/opt/homebrew/bin/fish', [], '/tmp');
    expect(spawnedArgs()).toEqual(['-l', '-i']);
    service.forceKill('f1');
  });
});

// helper 的 bash/fish 集成会污染子进程环境:bash 注入 BASH_ENV/ENV=<生成的 rc> → 终端里每个
// 非交互 `bash -c` / bash 脚本都重复 source 用户启动文件并把 OSC7 打到 stdout;fish 改写
// XDG_CONFIG_HOME → 子程序(nvim 等)找错配置目录。故 Continuo 对 bash/fish 不调用 helper、
// 用原始 env(跨仓 follow-up 见 doc/follow-ups.md)。
describe('shell spawn env 约定(bash / fish 不采用 helper env)', () => {
  beforeEach(() => {
    service.__resetForTest();
    setMcpRevokers({ byToken: vi.fn(), byWindow: vi.fn() });
    sessionManagerMock.create.mockReset().mockResolvedValue({ session_id: 'created' });
  });

  it('bash → env 不含 helper 注入的 BASH_ENV / ENV / _TERMINAL_USER_*', async () => {
    await service.createTerminal('be1', makeWindow(5), '/bin/bash', [], '/tmp');
    const env = spawnedEnv();

    expect(env.BASH_ENV).toBe(process.env.BASH_ENV);
    expect(env.ENV).toBe(process.env.ENV);
    expect(env._TERMINAL_USER_BASH_RC).toBeUndefined();
    expect(env._TERMINAL_USER_HOME).toBeUndefined();
    expect(Object.values(env).some((v) => String(v).includes('continuo-shell-'))).toBe(false);
    service.forceKill('be1');
  });

  it('fish → env 不改写 XDG_CONFIG_HOME', async () => {
    await service.createTerminal('fe1', makeWindow(6), '/opt/homebrew/bin/fish', [], '/tmp');
    const env = spawnedEnv();

    expect(env.XDG_CONFIG_HOME).toBe(process.env.XDG_CONFIG_HOME);
    expect(env._TERMINAL_USER_FISH_CONFIG).toBeUndefined();
    expect(Object.values(env).some((v) => String(v).includes('continuo-shell-'))).toBe(false);
    service.forceKill('fe1');
  });

  // 真实子进程:用 terminal.service 算出的 env 跑非交互 bash,stdout 不得混入 OSC7 / 启动文件输出。
  it.skipIf(!existsSync('/bin/bash'))(
    '真实 /bin/bash -c "printf OK" 在该 env 下输出恰为 OK',
    async () => {
      await service.createTerminal('be2', makeWindow(7), '/bin/bash', [], '/tmp');
      const env = spawnedEnv();

      const out = execFileSync('/bin/bash', ['-c', 'printf OK'], { env, encoding: 'utf8' });
      expect(out).toBe('OK');
      service.forceKill('be2');
    },
  );
});

// 安全(会话绑定):每个 PTY 注入自己的终端会话 id,managed Stop hook 把它写进事件文件名,broker 只把
// Stop 事件交给该会话的 await_stop_hook 等待者。必须是内部值:调用方传入的 env 不能伪造成他会话 id。
describe('shell spawn env 注入终端会话 id', () => {
  beforeEach(() => {
    service.__resetForTest();
    setMcpRevokers({ byToken: vi.fn(), byWindow: vi.fn() });
    sessionManagerMock.create.mockReset().mockResolvedValue({ session_id: 'created' });
  });

  it('CONTINUO_TERMINAL_SESSION_ID = 本会话 id,传入 env 不能覆盖', async () => {
    await service.createTerminal('term-sid-1', makeWindow(8), '/bin/zsh', [], '/tmp', {
      CONTINUO_TERMINAL_SESSION_ID: 'term-victim',
    });

    expect(spawnedEnv().CONTINUO_TERMINAL_SESSION_ID).toBe('term-sid-1');
    service.forceKill('term-sid-1');
  });
});
