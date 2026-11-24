import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  // 终审 P1:debug.evaluate('x'.repeat(16777216)) 的响应帧约 16MiB,旧解码器每个 chunk 都 Buffer.concat 整个缓冲
  // (O(n²) 复制)且要等收完整帧才由服务层截断,RSS 冲到 ~1.1GiB。单帧上限降到 8MiB;超限帧不缓冲、边收边丢,
  // 能从帧体前缀认出是响应时合成一个失败响应,只 reject 对应请求 —— 不走畸形流路径断开整条会话。
  it('单帧上限为 8MiB', () => {
    expect(DAP_MAX_FRAME_BYTES).toBe(8 * 1024 * 1024);
  });

  function oversizedFrame(prefix: string): Buffer {
    const bodyLength = DAP_MAX_FRAME_BYTES + 1;
    const body = Buffer.alloc(bodyLength, 0x78);
    body.write(prefix, 0, 'utf8');
    return Buffer.concat([Buffer.from(`Content-Length: ${bodyLength}\r\n\r\n`, 'ascii'), body]);
  }

  function feedInChunks(decoder: DapStreamDecoder, data: Buffer, size: number): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < data.length; i += size) out.push(...decoder.push(data.subarray(i, i + size)));
    return out;
  }

  it('超限响应帧 → 不抛错,丢弃帧体并合成失败响应(只针对其 request_seq);后续帧照常解码', () => {
    const decoder = new DapStreamDecoder();
    const data = Buffer.concat([
      oversizedFrame('{"seq":8,"type":"response","request_seq":5,"command":"evaluate","success":true,"body":{"result":"'),
      encodeDapMessage({ seq: 9, type: 'event', event: 'output' }),
    ]);
    expect(feedInChunks(decoder, data, 64 * 1024)).toEqual([
      expect.objectContaining({
        type: 'response',
        request_seq: 5,
        command: 'evaluate',
        success: false,
        message: expect.stringMatching(/exceeds/),
      }),
      expect.objectContaining({ seq: 9, type: 'event', event: 'output' }),
    ]);
  });

  it('超限事件帧(认不出 request_seq)→ 静默丢弃,后续帧照常解码', () => {
    const decoder = new DapStreamDecoder();
    const data = Buffer.concat([
      oversizedFrame('{"seq":10,"type":"event","event":"output","body":{"output":"'),
      encodeDapMessage({ seq: 11, type: 'event', event: 'stopped' }),
    ]);
    expect(feedInChunks(decoder, data, 64 * 1024)).toEqual([
      expect.objectContaining({ seq: 11, event: 'stopped' }),
    ]);
  });

  function copiedBytes(concat: { mock: { results: Array<{ value: unknown }> } }, from = 0): number {
    return concat.mock.results.slice(from).reduce((sum, r) => sum + (r.value as Buffer).length, 0);
  }

  it('超限帧不缓冲整帧:边收边丢,复制量与帧长无关', () => {
    const decoder = new DapStreamDecoder();
    const data = oversizedFrame('{"seq":10,"type":"event","event":"output","body":{"output":"');
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      feedInChunks(decoder, data, 64 * 1024);
      expect(copiedBytes(concat)).toBeLessThan(1024 * 1024);
    } finally {
      concat.mockRestore();
    }
  });

  it('分块收大帧:拼接复制量随帧长线性(凑够整帧才一次性拼接),不是每 chunk 复制累计数据', () => {
    const decoder = new DapStreamDecoder();
    const frame = encodeDapMessage({
      seq: 1,
      type: 'event',
      event: 'output',
      body: { output: 'y'.repeat(4 * 1024 * 1024) },
    });
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      const messages = feedInChunks(decoder, frame, 4 * 1024);
      expect(messages).toHaveLength(1);
      expect(copiedBytes(concat)).toBeLessThan(2 * frame.length);
    } finally {
      concat.mockRestore();
    }
  });

  it('超限响应 → DapClient 只 reject 对应请求,连接与其它在途请求不受影响', async () => {
    const client = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const socket = connected(client);
    const evaluate = client.sendRequest('evaluate', {}, 5_000);
    const threads = client.sendRequest('threads', {}, 5_000);
    const [evalSeq, threadsSeq] = socket.written.map((chunk) => {
      const text = chunk.toString('utf8');
      return (JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4)) as { seq: number }).seq;
    });

    const big = oversizedFrame(
      `{"seq":20,"type":"response","request_seq":${evalSeq},"command":"evaluate","success":true,"body":{"result":"`,
    );
    for (let i = 0; i < big.length; i += 1024 * 1024) socket.emit('data', big.subarray(i, i + 1024 * 1024));
    await expect(evaluate).rejects.toThrow(/exceeds/);
    expect(socket.destroyed).toBe(false);

    socket.emit(
      'data',
      encodeDapMessage({
        seq: 21,
        type: 'response',
        request_seq: threadsSeq!,
        command: 'threads',
        success: true,
        body: { threads: [] },
      }),
    );
    await expect(threads).resolves.toMatchObject({ request_seq: threadsSeq, success: true });
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

  // worker 反复创建 / 结束:DebugService 逐个 dispose 结束的 child,父 client 不能继续持有它们。
  it('单独 dispose 的 child 从父 client 的子会话列表中移除', async () => {
    const parent = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const children = Array.from({ length: 5 }, () => parent.createChildSession());
    await Promise.all(children.slice(0, 4).map((child) => child.dispose()));
    const held = (parent as unknown as { childSessions: DapClient[] }).childSessions;
    expect(held).toEqual([children[4]]);
    await parent.dispose();
    expect((parent as unknown as { childSessions: DapClient[] }).childSessions).toEqual([]);
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

// 终审:socket 曾直接放在 os.tmpdir()(路径过长 / Linux 上回退到全局共享的 /tmp),本机其它用户能否连上
// 只取决于 umask。现放进 mkdtemp 建的私有目录(0700)。同一用户的其它进程不在威胁模型内。
describe.skipIf(process.platform === 'win32')('socket 路径(POSIX 私有目录)', () => {
  async function listeningAdapter(): Promise<{ dir: string; adapterPath: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'dap-listen-'));
    const adapterPath = path.join(dir, 'listen.cjs');
    // 在 argv 给的 socket 路径上监听,让 spawnServer 能连上。
    await writeFile(
      adapterPath,
      "require('node:net').createServer((s) => s.on('error', () => {})).listen(process.argv[2]);\n",
    );
    return { dir, adapterPath };
  }

  it('socket 位于 0700 私有目录中(不受 umask 影响);dispose 后 socket 与目录都被删除', async () => {
    const fixture = await listeningAdapter();
    const previousUmask = process.umask(0o000);
    const client = new DapClient({
      adapterPath: fixture.adapterPath,
      readyTimeoutMs: 5_000,
      connectIntervalMs: 20,
    });
    try {
      await client.spawnServer();
      process.umask(previousUmask);
      const socketPath = client.socketPath!;
      const dir = path.dirname(socketPath);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(dir).uid).toBe(process.getuid!());
      expect(statSync(socketPath).isSocket()).toBe(true);
      // unix socket 路径上限(macOS 104 / Linux 108 字节,含结尾 NUL)。
      expect(Buffer.byteLength(socketPath)).toBeLessThan(104);

      await client.dispose();
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(dir)).toBe(false);
    } finally {
      process.umask(previousUmask);
      await client.dispose();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('并发的两个 client 各用各的私有目录(并发 launch 不串线)', async () => {
    const fixture = await listeningAdapter();
    const a = new DapClient({ adapterPath: fixture.adapterPath, connectIntervalMs: 20 });
    const b = new DapClient({ adapterPath: fixture.adapterPath, connectIntervalMs: 20 });
    try {
      await Promise.all([a.spawnServer(), b.spawnServer()]);
      expect(path.dirname(a.socketPath!)).not.toBe(path.dirname(b.socketPath!));
    } finally {
      await Promise.all([a.dispose(), b.dispose()]);
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  // 清理据此判断:adapter 已退出后其 pid 可能被无关进程复用,不能再对它发信号。
  it('serverExited:adapter 运行中为 false,子进程退出后为 true', async () => {
    const fixture = await listeningAdapter();
    const client = new DapClient({ adapterPath: fixture.adapterPath, connectIntervalMs: 20 });
    try {
      expect(client.serverExited).toBe(false); // 未 spawn
      await client.spawnServer();
      expect(client.serverExited).toBe(false);
      const exited = new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (client.serverExited) {
            clearInterval(timer);
            resolve();
          }
        }, 10);
      });
      process.kill(client.serverPid!, 'SIGKILL'); // 本测试自己 spawn 的 adapter 子进程
      await exited;
      expect(client.serverExited).toBe(true);
    } finally {
      await client.dispose();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  // debug.service 在 adapter 退出那一刻回收其进程组(之后 pgid 可能被复用)。
  it('onServerExit:adapter 子进程退出时回调;已退出后再注册也会回调', async () => {
    const fixture = await listeningAdapter();
    const client = new DapClient({ adapterPath: fixture.adapterPath, connectIntervalMs: 20 });
    try {
      await client.spawnServer();
      const first = new Promise<void>((resolve) => client.onServerExit(resolve));
      process.kill(client.serverPid!, 'SIGKILL'); // 本测试自己 spawn 的 adapter 子进程
      await first;
      expect(client.serverExited).toBe(true);
      await new Promise<void>((resolve) => client.onServerExit(resolve));
    } finally {
      await client.dispose();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('adapter 启动失败 → dispose 同样删除私有目录', async () => {
    const client = new DapClient({
      adapterPath: '/nonexistent/adapter.js',
      nodePath: '/nonexistent/continuo-test-node',
      readyTimeoutMs: 1_000,
      connectIntervalMs: 10,
    });
    await expect(client.spawnServer()).rejects.toThrow();
    const dir = path.dirname(client.socketPath!);
    expect(existsSync(dir)).toBe(true);
    await client.dispose();
    expect(existsSync(dir)).toBe(false);
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

  it('runInTerminal 反向请求不执行 → 如实回复 success:false 并说明不支持(不谎报已启动)', async () => {
    const client = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const socket = connected(client);
    client.receiveMessage({
      seq: 7,
      type: 'request',
      command: 'runInTerminal',
      arguments: { kind: 'integrated', cwd: '/work', args: ['node', 'evil.js'] },
    });
    await new Promise((r) => setTimeout(r, 0));
    const replies = socket.written.map((chunk) => {
      const text = chunk.toString('utf8');
      return JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4)) as Record<string, unknown>;
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      type: 'response',
      request_seq: 7,
      command: 'runInTerminal',
      success: false,
      message: 'runInTerminal not supported',
    });
    expect(replies[0]).not.toHaveProperty('body');
  });

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

describe('adapter 就绪前退出', () => {
  /** 假 adapter:记下每次被 spawn 时收到的端点参数,然后立刻失败退出。 */
  async function failingAdapter() {
    const dir = await mkdtemp(path.join(tmpdir(), 'dap-exit-early-'));
    const log = path.join(dir, 'spawns.log');
    const adapterPath = path.join(dir, 'adapter.cjs');
    await writeFile(
      adapterPath,
      [
        'const [endpoint] = process.argv.slice(2);',
        `require('node:fs').appendFileSync(${JSON.stringify(log)}, endpoint + '\\n');`,
        "console.error('Error: listen EADDRINUSE: address already in use ' + endpoint); process.exit(1);",
      ].join('\n'),
    );
    const spawns = (): string[] =>
      existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    return { dir, adapterPath, spawns };
  }

  it.skipIf(process.platform === 'win32')(
    'stderr 里跨 chunk 的多字节字符在报错信息中完整还原',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'dap-stderr-utf8-'));
      const adapterPath = path.join(dir, 'adapter.cjs');
      // 「端口被占用」的 UTF-8 字节拆成两次写:第一次只写到「端」的前两个字节。
      await writeFile(
        adapterPath,
        [
          "const b = Buffer.from('端口被占用', 'utf8');",
          'process.stderr.write(b.subarray(0, 2));',
          'setTimeout(() => { process.stderr.write(b.subarray(2)); setTimeout(() => process.exit(1), 50); }, 100);',
        ].join('\n'),
      );
      const client = new DapClient({ adapterPath, readyTimeoutMs: 10_000, connectIntervalMs: 20 });
      try {
        const err = await client.spawnServer().then(
          () => null,
          (e: unknown) => e as Error,
        );
        expect(err?.message).toContain('端口被占用');
        expect(err?.message).not.toContain('\uFFFD');
      } finally {
        await client.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')('立即失败(不等满 readyTimeout),只 spawn 一次', async () => {
    const fixture = await failingAdapter();
    const client = new DapClient({
      adapterPath: fixture.adapterPath,
      readyTimeoutMs: 10_000,
      connectIntervalMs: 20,
    });
    const startedAt = Date.now();
    try {
      await expect(client.spawnServer()).rejects.toThrow(/exited before ready/);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(fixture.spawns()).toHaveLength(1);
    } finally {
      await client.dispose();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
});
