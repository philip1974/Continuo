// prepareShellIntegrationEnv 返回的 bash args(['--rcfile', <生成的 rc>, '-i'])是**非 login** 启动:
// 不读 /etc/profile(macOS path_helper 在此),且 rcfile 无条件依次 source .bash_profile/.profile/.bashrc
// → 重复执行、偏离原 `-l -i` 语义。故 Continuo 暂不采用 helper 的 bash args(待 helper 模拟 login
// 启动文件选择后再启用,见 doc/follow-ups.md):bash 仍 `-l -i`,用户 args 优先,zsh/fish 不变。
// 这里用真实 helper(不 mock),只 mock SessionManager 捕获最终 spawn 参数。
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
