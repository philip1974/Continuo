// 安全:插件 shell.exec / 流式 shell / git 子进程的 env 不得带宿主内部机密 CONTINUO_MCP_TOKEN(Continuo 从带 token
// 的终端启动时 process.env 即含它;插件也可能显式透传)。持有 token 即可经 MCP HTTP 以该窗口身份调用工具。
// 同时钉住 git 两个入口的离线 / 协议白名单 env:readGitBlob 用 GIT_OFFLINE_ENV,插件 git 安装(runGit)限 https。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

const spawnEnvs: NodeJS.ProcessEnv[] = [];
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = Object.assign(new EventEmitter(), { write() {}, end() {} });
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    return true;
  }
}
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (_cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    spawnEnvs.push(opts.env);
    const c = new FakeChild();
    queueMicrotask(() => {
      c.emit('exit', 1, null);
      c.emit('close', 1, null);
    });
    return c;
  },
}));

import { execShell } from '../services/shell.service';
import { registerPluginShellStreamHandlers } from '../services/plugin-shell-stream.service';
import { readGitBlob } from '../services/plugin-fs.service';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../shared/plugin-shell-stream-channels';
import { installFromGit } from '../services/plugins.service';

const realToken = process.env.CONTINUO_MCP_TOKEN;
beforeEach(() => {
  spawnEnvs.length = 0;
  process.env.CONTINUO_MCP_TOKEN = 'secret-token';
});
afterEach(() => {
  if (realToken === undefined) delete process.env.CONTINUO_MCP_TOKEN;
  else process.env.CONTINUO_MCP_TOKEN = realToken;
});

function lastEnv(): NodeJS.ProcessEnv {
  expect(spawnEnvs.length).toBeGreaterThan(0);
  return spawnEnvs[spawnEnvs.length - 1]!;
}

describe('插件 / git 子进程 env 剥离 CONTINUO_MCP_TOKEN', () => {
  it('shell.exec:继承的与插件显式传入的 token 都被剥离;git 加固照常注入', async () => {
    await execShell({ cmd: 'git', args: ['status'], cwd: '/ws', env: { CONTINUO_MCP_TOKEN: 'x', FOO: '1' } });
    const env = lastEnv();
    expect(env.CONTINUO_MCP_TOKEN).toBeUndefined();
    expect(env.FOO).toBe('1');
    expect(env).toMatchObject({ GIT_CONFIG_KEY_0: 'core.fsmonitor' });
  });

  it('流式 shell:剥离 token', async () => {
    const handlers = new Map<string, (...a: unknown[]) => Promise<void>>();
    registerPluginShellStreamHandlers({
      handle: (ch: string, h: (...a: unknown[]) => Promise<void>) => handlers.set(ch, h),
    } as never);
    const sender = { id: 9201, isDestroyed: () => false, send: () => {}, once: () => {}, on: () => {} };
    await handlers
      .get(PLUGIN_SHELL_STREAM_CHANNELS.START)!(
        { sender, senderFrame: { url: 'file:///app/index.html' } },
        's-secret',
        'git',
        ['status'],
        { cwd: '/ws' },
      )
      .catch(() => undefined);
    expect(lastEnv().CONTINUO_MCP_TOKEN).toBeUndefined();
  });

  it('readGitBlob:剥离 token,并带 GIT_OFFLINE_ENV(禁惰性拉取 + 空协议白名单)', async () => {
    await readGitBlob('/ws', '1234567890123456789012345678901234567890').catch(() => undefined);
    const env = lastEnv();
    expect(env.CONTINUO_MCP_TOKEN).toBeUndefined();
    expect(env).toMatchObject({ GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' });
  });

  it('插件 git 安装(runGit):剥离 token,且协议白名单只允许 https', async () => {
    await installFromGit('https://example.com/p.git', '/plugins').catch(() => undefined);
    const env = lastEnv();
    expect(env.CONTINUO_MCP_TOKEN).toBeUndefined();
    expect(env).toMatchObject({ GIT_ALLOW_PROTOCOL: 'https', GIT_TERMINAL_PROMPT: '0' });
  });
});
