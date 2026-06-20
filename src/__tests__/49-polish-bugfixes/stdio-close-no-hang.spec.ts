import { connect, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// BrowserWindow 只在连接 dispatch 的 fallback 选窗用到;close() 路径不碰它。
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  createStdioSocketServer,
  type StdioSocketServer,
} from '../../../electron/main/services/mcp-stdio-server.service';
import type { ServerInfo } from '../../../electron/main/services/mcp-host.service';

const serverInfo: ServerInfo = {
  name: 'test',
  version: '0.0.0',
  protocolVersion: '2024-11-05',
};

const dirs: string[] = [];
const clients: Socket[] = [];
let server: StdioSocketServer | null = null;

afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  if (server) {
    await server.close().catch(() => {});
    server = null;
  }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const isWin = process.platform === 'win32';

// P2 回归:close() 旧实现只 clients.clear() 不 destroy socket → server.close() 的
// 回调要等所有现存连接关闭才 fire,有活动客户端时回调永不触发 → close() promise
// 永久挂起,socket 文件也来不及 unlink 残留。修复:close 前 destroy 所有连接。
describe.skipIf(isWin)('49 · stdio close() 有活动连接也不挂起', () => {
  it('客户端连接中调 close() → 及时 resolve 且 socket 文件被清', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'continuo-stdio-'));
    dirs.push(dir);
    const socketPath = join(dir, 'mcp.sock');

    server = await createStdioSocketServer({
      socketPath,
      tools: new Map(),
      serverInfo,
      resolveWindowId: () => null,
    });

    // 建立一个活动连接并保持打开
    const client = connect(socketPath);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });

    // close() 必须在合理时间内 resolve(旧实现会永久挂起)
    const closed = await Promise.race([
      server.close().then(() => 'closed' as const),
      new Promise<'hang'>((resolve) => setTimeout(() => resolve('hang'), 2000)),
    ]);
    server = null;

    expect(closed).toBe('closed');
    expect(existsSync(socketPath)).toBe(false);
  });
});
