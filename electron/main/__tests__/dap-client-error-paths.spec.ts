import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DAP_MAX_FRAME_BYTES,
  DapClient,
  DapStreamDecoder,
  encodeDapMessage,
} from '../services/dap-client';

// DapClient 错误路径:都是「对端是本机 js-debug,概率低」的分支,但一旦走到,此前会变成主进程的
// unhandledRejection / uncaughtException,或留下不释放的 pending / 监听。

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  unhandled.length = 0;
  vi.useRealTimers();
});

function internals(client: DapClient): {
  pending: Map<number, unknown>;
  eventHandlers: Map<string, Set<unknown>>;
} {
  return client as unknown as ReturnType<typeof internals>;
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  written: Buffer[] = [];
  write(chunk: Buffer): boolean {
    this.written.push(chunk);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function connected(client: DapClient): FakeSocket {
  const socket = new FakeSocket();
  (client as unknown as { socket: unknown }).socket = socket;
  client.attachSocket(socket as unknown as Socket);
  return socket;
}

describe('sendRequest', () => {
  it('socket 未连接 → 返回的 Promise reject,不残留 pending,也不留下迟到的超时 rejection', async () => {
    process.on('unhandledRejection', onUnhandled);
    const client = new DapClient({ adapterPath: '/nonexistent/adapter.js' });

    await expect(client.sendRequest('disconnect', {}, 20)).rejects.toThrow(/not connected/);
    expect(internals(client).pending.size).toBe(0);

    await new Promise((r) => setTimeout(r, 60)); // 越过 20ms 超时
    expect(unhandled).toEqual([]);
  });

  it('请求超时 → 删除对应 pending 条目', async () => {
    const client = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    connected(client);
    await expect(client.sendRequest('stackTrace', {}, 10)).rejects.toThrow(/timed out/);
    expect(internals(client).pending.size).toBe(0);
  });
});

describe('waitForEvent', () => {
  it('超时 → 摘掉事件监听', async () => {
    const client = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    await expect(client.waitForEvent('initialized', 10)).rejects.toThrow(/timed out/);
    expect(internals(client).eventHandlers.get('initialized')?.size ?? 0).toBe(0);
  });
});

describe('入站数据', () => {
  it('Content-Length 超过上限 → 解码器抛错(不为巨帧无界缓冲)', () => {
    const decoder = new DapStreamDecoder();
    expect(() =>
      decoder.push(Buffer.from(`Content-Length: ${DAP_MAX_FRAME_BYTES + 1}\r\n\r\n`, 'ascii')),
    ).toThrow(/exceeds/);
  });

  it('畸形帧 → 不抛到 socket 的 data 回调之外;结算在途请求并断开连接', async () => {
    const client = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const socket = connected(client);
    const pending = client.sendRequest('threads', {}, 5_000);

    expect(() => socket.emit('data', Buffer.from('garbage-without-length\r\n\r\n'))).not.toThrow();
    await expect(pending).rejects.toThrow(/malformed|Content-Length/i);
    expect(socket.destroyed).toBe(true);
    // 断开后的后续 chunk 不再反复解码抛错
    expect(() => socket.emit('data', Buffer.from('more'))).not.toThrow();
  });

  it('正常帧照常解码', () => {
    const decoder = new DapStreamDecoder();
    const frame = encodeDapMessage({ seq: 1, type: 'event', event: 'output' });
    expect(decoder.push(frame)).toHaveLength(1);
  });
});

describe('adapter 子进程', () => {
  it('spawn 失败(可执行文件不存在)→ spawnServer reject,不抛未捕获异常', async () => {
    const client = new DapClient({
      adapterPath: '/nonexistent/adapter.js',
      nodePath: '/nonexistent/continuo-test-node',
      readyTimeoutMs: 3_000,
      connectIntervalMs: 10,
    });
    const startedAt = Date.now();
    await expect(client.spawnServer()).rejects.toThrow(/spawn|ENOENT/i);
    // 不必等满 readyTimeout
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await client.dispose();
  });
});

describe('socket 路径', () => {
  it('同一毫秒构造的两个 client 路径不同(并发 launch 不串线)', () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const a = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const b = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    expect(a.socketPath).not.toBe(b.socketPath);
  });
});
