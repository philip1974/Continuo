import { EventEmitter } from 'node:events';
import { promises as fsPromises } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 攻击场景(Windows 专属):js-debug dapDebugServer 旧实现在 Windows 上监听 127.0.0.1 TCP 随机端口 ——
// 本机其它用户可直连;浏览器页面也能对 127.0.0.1 发 no-cors POST(请求头带 Content-Length,可能被当作 DAP
// 帧解析)→ 发 launch 让 adapter 以 Continuo 用户身份跑任意 runtimeExecutable。
// 修复:Windows 默认改监听随机名命名管道(js-debug 对非数字参数走 listen({ path }));浏览器无法触达命名
// 管道,libuv 默认 DACL 只给创建者读写,随机名(128 bit)不可预测,无从抢注。

const spawnCalls: Array<{ args: readonly string[] }> = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((_cmd: string, args: readonly string[]) => {
      spawnCalls.push({ args });
      const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null };
      child.stdout = null;
      child.stderr = null;
      // 模拟 spawn 失败:waitForReady 立刻失败,不真起进程。
      queueMicrotask(() => child.emit('error', new Error('fake spawn failure')));
      return child;
    }),
  };
});

const { DapClient } = await import('../services/dap-client');

const PIPE_RE = /^\\\\\.\\pipe\\continuo-dap-[0-9a-f]{32}$/;

const realPlatform = process.platform;
function stubPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  spawnCalls.length = 0;
  vi.restoreAllMocks();
});

describe('Windows 上 DAP 端点默认用随机名命名管道(不再监听 TCP)', () => {
  it('默认构造 → socketPath 为 \\\\.\\pipe\\continuo-dap-<随机>,每个 client 不同', () => {
    stubPlatform('win32');
    const a = new DapClient({ adapterPath: 'C:\\adapter\\dapDebugServer.js' });
    const b = new DapClient({ adapterPath: 'C:\\adapter\\dapDebugServer.js' });
    expect(a.socketPath).toMatch(PIPE_RE);
    expect(b.socketPath).toMatch(PIPE_RE);
    expect(a.socketPath).not.toBe(b.socketPath);
  });

  it('spawn 参数是管道路径且不带 TCP host;不对管道路径做 fs.rm', async () => {
    stubPlatform('win32');
    const rm = vi.spyOn(fsPromises, 'rm');
    const client = new DapClient({ adapterPath: 'C:\\adapter\\dapDebugServer.js', readyTimeoutMs: 500 });
    await expect(client.spawnServer()).rejects.toThrow(/fake spawn failure/);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args).toEqual(['C:\\adapter\\dapDebugServer.js', client.socketPath]);
    await client.dispose();
    expect(rm).not.toHaveBeenCalledWith(client.socketPath, expect.anything());
  });

  it('child session 共用父的管道路径', () => {
    stubPlatform('win32');
    const parent = new DapClient({ adapterPath: 'C:\\adapter\\dapDebugServer.js' });
    expect(parent.createChildSession().socketPath).toBe(parent.socketPath);
  });
});
