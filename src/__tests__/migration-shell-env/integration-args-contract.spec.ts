// prepareShellIntegrationEnv 的调用方约定:spawn 时必须**同时**使用返回的 env 与 args。
// bash 的 args 是 ['--rcfile', <生成的 rc>, '-i'] —— 交互式 bash 忽略 BASH_ENV,只靠 env
// 永远装不上 OSC7 cwd hook。旧实现只解构 env/cleanup,bash 仍用默认 ['-l','-i'] 启动
// (login bash 也不读 --rcfile 之外的注入)→ cwd 跟踪对 bash 静默失效。
// 这里用真实 helper(不 mock),只 mock SessionManager 捕获最终 spawn 参数。
import { readFileSync } from 'node:fs';
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

describe('shell integration args 约定', () => {
  beforeEach(() => {
    service.__resetForTest();
    setMcpRevokers({ byToken: vi.fn(), byWindow: vi.fn() });
    sessionManagerMock.create.mockReset().mockResolvedValue({ session_id: 'created' });
  });

  it('bash 且用户未传 args → 用 helper 的 --rcfile 参数启动,rcfile 含 OSC7 hook', async () => {
    await service.createTerminal('b1', makeWindow(1), '/bin/bash', [], '/tmp');

    const args = spawnedArgs();
    expect(args[0]).toBe('--rcfile');
    expect(args).toContain('-i');
    expect(args).not.toContain('-l');
    // rcfile 真实存在,装 OSC7 hook 并回 source 用户 rc(.bash_profile/.bashrc)
    const rc = readFileSync(args[1]!, 'utf8');
    expect(rc).toContain('_continuo_osc7');
    expect(rc).toContain('.bash_profile');
    service.forceKill('b1');
  });

  it('bash 但用户显式传 args → 用户 args 优先', async () => {
    await service.createTerminal('b2', makeWindow(2), '/bin/bash', ['--norc'], '/tmp');

    expect(spawnedArgs()).toEqual(['--norc']);
    service.forceKill('b2');
  });

  it('zsh(helper args 为空)→ 仍用默认 login+interactive', async () => {
    await service.createTerminal('z1', makeWindow(3), '/bin/zsh', [], '/tmp');

    expect(spawnedArgs()).toEqual(['-l', '-i']);
    service.forceKill('z1');
  });
});
