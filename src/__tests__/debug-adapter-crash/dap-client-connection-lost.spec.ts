// @vitest-environment node
// BDD: debug-adapter-crash / DapClient 把 adapter 退出(code / signal)与连接意外断开交给调用方;本端 dispose 不算。见同目录 README。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DapClient, type DapServerExit } from '../../../electron/main/services/dap-client';

// 最小「adapter」:在给定端点上监听,接受连接后什么都不做(只为让 DapClient 连上)。
const FAKE_ADAPTER = `
const net = require('node:net');
const server = net.createServer(() => {});
server.listen(process.argv[2]);
`;

const dirs: string[] = [];
const clients: DapClient[] = [];

async function startClient(): Promise<DapClient> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dap-lost-'));
  dirs.push(dir);
  const adapterPath = path.join(dir, 'adapter.cjs');
  await writeFile(adapterPath, FAKE_ADAPTER);
  const client = new DapClient({ adapterPath, nodePath: process.execPath, readyTimeoutMs: 10_000 });
  clients.push(client);
  await client.spawnServer();
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.dispose().catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('DapClient:adapter 意外退出', () => {
  it('adapter 被杀 → onServerExit 带 signal,连接断开 → onConnectionLost', async () => {
    const client = await startClient();
    const exit = new Promise<DapServerExit>((resolve) => client.onServerExit(resolve));
    const lost = new Promise<void>((resolve) => client.onConnectionLost(resolve));
    process.kill(client.serverPid!, 'SIGKILL');
    await expect(exit).resolves.toEqual({ code: null, signal: 'SIGKILL' });
    await expect(lost).resolves.toBeUndefined();
  });

  it('已退出后再注册 onServerExit 也拿到退出状态', async () => {
    const client = await startClient();
    process.kill(client.serverPid!, 'SIGKILL');
    await new Promise<void>((resolve) => client.onServerExit(() => resolve()));
    await expect(new Promise<DapServerExit>((resolve) => client.onServerExit(resolve))).resolves.toEqual({
      code: null,
      signal: 'SIGKILL',
    });
  });

  it('本端 dispose 关掉连接 → 不回调 onConnectionLost', async () => {
    const client = await startClient();
    let lost = 0;
    client.onConnectionLost(() => {
      lost += 1;
    });
    await client.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lost).toBe(0);
  });
});
