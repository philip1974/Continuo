// @vitest-environment node
// BDD:stop-hook broker 不丢事件、不留孤儿等待者。见同目录 README。
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reads: [] as Array<{ resolve: (text: string) => void }>,
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  opendir: vi.fn(async () => ({
    async *[Symbol.asyncIterator]() {
      /* 目录初始为空 */
    },
    close: async () => undefined,
  })),
  stat: vi.fn(async () => ({ mtimeMs: Date.now(), size: 10 })),
  unlink: vi.fn(async () => undefined),
}));
vi.mock('../../../electron/main/lib/read-fh-capped', () => ({
  readFileCappedFd: vi.fn(
    () =>
      new Promise((resolve) => {
        h.reads.push({
          resolve: (text) => resolve({ text, tooLarge: false, size: text.length }),
        });
      }),
  ),
}));

import { opendir, stat } from 'node:fs/promises';
import { createHookFileBroker } from '../../../electron/main/services/mcp-tools-hook-bridge';
import { flushMicrotasks } from '../_helpers/async';

afterEach(() => {
  h.reads.length = 0;
  vi.clearAllMocks();
});

describe('写入中途的 hook 文件', () => {
  it('处理期间到达的同名事件 → 本次结束后补跑一次,事件不丢', async () => {
    let onFile: (name: string) => void = () => {};
    const broker = createHookFileBroker('/fake/hooks', {
      watchFactory: (_dir, cb) => {
        onFile = cb;
        return { close: () => {} };
      },
    });
    await broker.start();
    try {
      const file = 'codex_4_term-1_123.jsonl';
      const waiting = broker.awaitNext({ windowId: 4, sessionId: 'term-1', runner: 'codex', cwd: '/ws', timeoutMs: 60_000 });

      onFile(file); // 文件刚创建(内容还没写完)
      await flushMicrotasks(20);
      expect(h.reads).toHaveLength(1); // 第一次处理卡在读取

      onFile(file); // 写完的 change 事件,恰在第一次处理期间到达
      await flushMicrotasks(20);

      h.reads[0]!.resolve('{"sess'); // 第一次读到半截 → 解析失败
      await flushMicrotasks(20);
      expect(h.reads).toHaveLength(2); // 补跑
      h.reads[1]!.resolve('{"session_id":"s"}');

      await expect(waiting).resolves.toMatchObject({ fileName: file });
    } finally {
      await broker.stop();
    }
  });
});

describe('调用方断开', () => {
  it('signal abort → 等待者被撤销;同一 key 可立即重新等待', async () => {
    const broker = createHookFileBroker('/fake/hooks-abort');
    const filter = { windowId: 7, sessionId: 'term-1', runner: 'cc' as const, cwd: '/ws', timeoutMs: 600_000 };
    const controller = new AbortController();
    const first = broker.awaitNext(filter, controller.signal);
    const firstOutcome = first.catch((e: Error) => e.message);

    controller.abort();
    await expect(firstOutcome).resolves.toMatch(/disconnect|abort/i);

    // key 已让出:不再 ALREADY_PENDING
    const second = broker.awaitNext(filter);
    let settled = false;
    void second.then(
      () => (settled = true),
      () => (settled = true),
    );
    await flushMicrotasks(20);
    expect(settled).toBe(false);
    broker.cancelByWindow(7);
    await second.catch(() => {});
  });

  it('等待者正常结算(超时 / 窗口关闭)后摘掉 abort 监听(同一连接反复调用不累积)', async () => {
    vi.useFakeTimers();
    try {
      const broker = createHookFileBroker('/fake/hooks-listeners');
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');

      const timedOut = broker.awaitNext(
        { windowId: 7, sessionId: 'term-1', runner: 'cc', cwd: '/ws', timeoutMs: 1_000 },
        controller.signal,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(timedOut).resolves.toMatchObject({ status: 'timeout' });

      const cancelled = broker.awaitNext(
        { windowId: 7, sessionId: 'term-1', runner: 'cc', cwd: '/ws', timeoutMs: 600_000 },
        controller.signal,
      );
      broker.cancelByWindow(7);
      await cancelled.catch(() => {});

      expect(add).toHaveBeenCalledTimes(2);
      expect(remove).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('传入已 abort 的 signal → 立即 reject,不登记等待者', async () => {
    const broker = createHookFileBroker('/fake/hooks-aborted');
    const controller = new AbortController();
    controller.abort();
    await expect(
      broker.awaitNext({ windowId: 7, sessionId: 'term-1', runner: 'cc', cwd: '/ws', timeoutMs: 600_000 }, controller.signal),
    ).rejects.toThrow(/disconnect|abort/i);
    expect(broker.cancelByWindow(7)).toBe(0);
  });
});

// perf:start() 在首窗创建前处理目录存量(最多 4096 个文件)。此前逐文件串行 stat+read+parse,
// 首窗延迟 = 所有文件 I/O 之和。改为有界并发读取,但按文件名顺序提交结果(buffered 先后不变)。
describe('启动存量扫描', () => {
  it('有界并发读取,按文件名顺序入 buffered', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `codex_4_term-1_${1000 + i}.jsonl`);
    vi.mocked(opendir).mockImplementationOnce((async () => ({
      async *[Symbol.asyncIterator]() {
        // 乱序枚举:broker 自行按文件名排序
        for (const name of [...names].reverse()) yield { name };
      },
      close: async () => undefined,
    })) as unknown as typeof opendir);
    // 中间一个超大文件:不读、直接隔离(提前返回),不能让它打断前后文件的提交顺序链。
    const oversize = names[20]!;
    vi.mocked(stat).mockImplementation((async (p: string) => ({
      mtimeMs: Date.now(),
      size: p.endsWith(oversize) ? 2 * 1024 * 1024 : 10,
    })) as unknown as typeof stat);
    const broker = createHookFileBroker('/fake/hooks-backlog', {
      watchFactory: () => ({ close: () => {} }),
    });
    let started = false;
    const starting = broker.start().then(() => {
      started = true;
    });
    let maxInFlight = 0;
    let served = 0;
    while (!started) {
      await flushMicrotasks(20);
      const open = h.reads.splice(0);
      maxInFlight = Math.max(maxInFlight, open.length);
      // 倒序完成读取:提交顺序仍须按文件名
      for (const read of open.reverse()) {
        read.resolve(`{"session_id":"s${served}"}`);
        served += 1;
      }
      if (open.length === 0) await new Promise((r) => setTimeout(r, 0));
    }
    await starting;
    try {
      expect(served).toBe(names.length - 1);
      expect(maxInFlight).toBeGreaterThan(1);
      expect(maxInFlight).toBeLessThanOrEqual(16);
      const got: string[] = [];
      for (let i = 0; i < names.length - 1; i += 1) {
        const entry = await broker.awaitNext({ windowId: 4, sessionId: 'term-1', runner: 'codex', cwd: '/ws', timeoutMs: 1000 });
        got.push('fileName' in entry ? entry.fileName : 'timeout');
      }
      expect(got).toEqual(names.filter((name) => name !== oversize));
    } finally {
      vi.mocked(stat).mockImplementation((async () => ({ mtimeMs: Date.now(), size: 10 })) as unknown as typeof stat);
      await broker.stop();
    }
  });
});
