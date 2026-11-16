import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

  // 合法 framing 但 JSON 顶层不是 DAP 消息对象:此前被接受并强转,receiveMessage 读 null.type 抛 TypeError,
  // 而派发不在 try/catch 内 → 主进程未捕获异常。
  it.each([
    ['null', 'null'],
    ['数组', '[1,2]'],
    ['字符串', '"hello"'],
    ['数字', '42'],
    ['type 非字符串', '{"seq":1,"type":7}'],
  ])('顶层为%s → 解码器按畸形帧抛错', (_label, body) => {
    const decoder = new DapStreamDecoder();
    const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, 'utf8');
    expect(() => decoder.push(frame)).toThrow(/DAP message/i);
  });

  it('顶层为 null 的帧 → 不抛到 data 回调之外;结算在途请求并断开连接', async () => {
    const client = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const socket = connected(client);
    const pending = client.sendRequest('threads', {}, 5_000);

    expect(() => socket.emit('data', Buffer.from('Content-Length: 4\r\n\r\nnull'))).not.toThrow();
    await expect(pending).rejects.toThrow(/malformed/i);
    expect(socket.destroyed).toBe(true);
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

describe('child session 的释放', () => {
  it('dispose child 不删父 adapter 的监听 socket 文件(二者共用同一路径)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dap-child-dispose-'));
    const socketPath = path.join(dir, 'adapter.sock');
    await writeFile(socketPath, '');
    try {
      const parent = new DapClient({ adapterPath: '/nonexistent/adapter.js', socketPath });
      const child = parent.createChildSession();
      await child.dispose();
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // 结束的 child(terminated)由服务层回收:js-debug 可能在 terminated 之后才回在途请求的响应,先关 socket
  // 会让这些请求以「DAP socket closed」失败。
  it('disposeWhenIdle:有在途请求时等其响应到达后才关 socket;无在途请求时立即释放', async () => {
    const client = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const socket = connected(client);
    const request = client.sendRequest('continue', {}, 1_000);

    const disposed = client.disposeWhenIdle();
    await new Promise((r) => setTimeout(r, 10));
    expect(socket.destroyed).toBe(false);

    socket.emit(
      'data',
      encodeDapMessage({
        seq: 9,
        type: 'response',
        request_seq: 1,
        command: 'continue',
        success: true,
        body: {},
      }),
    );
    await expect(request).resolves.toMatchObject({ command: 'continue' });
    await disposed;
    expect(socket.destroyed).toBe(true);

    const idle = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const idleSocket = connected(idle);
    await idle.disposeWhenIdle();
    expect(idleSocket.destroyed).toBe(true);
  });

  it('disposeWhenIdle:在途请求超时同样结算 → 随后释放(不因对端不应答而一直保留)', async () => {
    const client = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const socket = connected(client);
    const request = client.sendRequest('continue', {}, 20);
    const disposed = client.disposeWhenIdle();
    await expect(request).rejects.toThrow(/timed out/);
    await disposed;
    expect(socket.destroyed).toBe(true);
  });
});

describe('解码器缓冲', () => {
  it('迟迟不出现帧头结束符 → 缓冲超过头部上限即抛(不无界增长)', () => {
    const decoder = new DapStreamDecoder();
    expect(() => {
      for (let i = 0; i < 40; i += 1) decoder.push(Buffer.alloc(4096, 0x41));
    }).toThrow(/header/i);
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

describe('反向请求的回复', () => {
  // child 初始化期间 socket 被 dispose:handler 之后成功 / 失败,回复都写不出去。此前 sendMessage 同步抛,
  // 而调用处 void 丢弃了 Promise → 主进程 unhandledRejection。
  for (const outcome of ['resolve', 'reject'] as const) {
    it(`startDebugging handler 在 dispose 之后才 ${outcome} → 静默放弃回复,无未处理 rejection`, async () => {
      process.on('unhandledRejection', onUnhandled);
      let settle!: () => void;
      const gate = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const client = new DapClient({
        adapterPath: '/nonexistent/adapter.js',
        startDebuggingHandler: async () => {
          await gate;
          if (outcome === 'reject') throw new Error('child handshake failed');
          return {};
        },
      });
      const socket = connected(client);
      client.receiveMessage({ seq: 5, type: 'request', command: 'startDebugging', arguments: {} });
      await client.dispose();
      settle();

      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
      expect(socket.written).toHaveLength(0);
    });
  }

  it('socket 已关闭时收到不支持的反向请求 → 不抛、无未处理 rejection', async () => {
    process.on('unhandledRejection', onUnhandled);
    const client = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const socket = connected(client);
    socket.destroyed = true;
    expect(() =>
      client.receiveMessage({ seq: 6, type: 'request', command: 'runInTerminal', arguments: {} }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
  });
});

describe('TCP 端点(Windows)', () => {
  // dapDebugServer.js 的参数是 `[port|socket path] [host=localhost]`;不传 host 时 localhost 可能解析成 ::1,
  // 而客户端固定连 127.0.0.1 → readiness 超时。spawn 时必须显式传 127.0.0.1。
  it('无 socket 路径时 spawn adapter 的参数含 host 127.0.0.1(与客户端连接地址一致)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dap-tcp-host-'));
    const adapterPath = path.join(dir, 'echo-argv.cjs');
    await writeFile(adapterPath, 'process.stderr.write(JSON.stringify(process.argv.slice(2)));\n');
    try {
      const client = new DapClient({
        adapterPath,
        socketPath: null,
        tcpPort: 45_678,
        readyTimeoutMs: 500,
        connectIntervalMs: 20,
      });
      const err = await client.spawnServer().then(
        () => null,
        (e: unknown) => e as Error,
      );
      await client.dispose();
      expect(err?.message).toContain('["45678","127.0.0.1"]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
