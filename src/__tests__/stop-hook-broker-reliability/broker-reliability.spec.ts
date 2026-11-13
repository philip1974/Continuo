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

import { createHookFileBroker } from '../../../electron/main/services/mcp-tools-hook-bridge';

afterEach(() => {
  h.reads.length = 0;
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

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
      const file = 'codex_4_123.jsonl';
      const waiting = broker.awaitNext({ windowId: 4, runner: 'codex', cwd: '/ws', timeoutMs: 60_000 });

      onFile(file); // 文件刚创建(内容还没写完)
      await flush();
      expect(h.reads).toHaveLength(1); // 第一次处理卡在读取

      onFile(file); // 写完的 change 事件,恰在第一次处理期间到达
      await flush();

      h.reads[0]!.resolve('{"sess'); // 第一次读到半截 → 解析失败
      await flush();
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
    const filter = { windowId: 7, runner: 'cc' as const, cwd: '/ws', timeoutMs: 600_000 };
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
    await flush();
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
        { windowId: 7, runner: 'cc', cwd: '/ws', timeoutMs: 1_000 },
        controller.signal,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(timedOut).resolves.toMatchObject({ status: 'timeout' });

      const cancelled = broker.awaitNext(
        { windowId: 7, runner: 'cc', cwd: '/ws', timeoutMs: 600_000 },
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
      broker.awaitNext({ windowId: 7, runner: 'cc', cwd: '/ws', timeoutMs: 600_000 }, controller.signal),
    ).rejects.toThrow(/disconnect|abort/i);
    expect(broker.cancelByWindow(7)).toBe(0);
  });
});
