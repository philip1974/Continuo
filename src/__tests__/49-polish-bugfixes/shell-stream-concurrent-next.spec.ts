// race(R93):plugin-shell-stream preload 的 chunks AsyncIterator 此前只存单个 chunkResolver,
// 两个 next() 并发等待时后者覆盖前者 → 先发 next() 的 Promise 永久不 resolve(消费方挂死),
// 且后续 chunk/exit 只唤醒最后一个等待者。改为 FIFO 等待者队列:chunk 到达 resolve 队首,
// exit 时 resolve 所有 pending 为 done。

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcRendererEvent } from 'electron';

let capturedHandler:
  | ((event: IpcRendererEvent, payload: unknown) => void)
  | null = null;
const invokeCalls: unknown[][] = [];

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (...a: unknown[]) => {
      invokeCalls.push(a);
      return Promise.resolve(undefined);
    },
    on: (_channel: string, h: (e: IpcRendererEvent, p: unknown) => void) => {
      capturedHandler = h;
    },
    removeListener: () => {},
  },
}));

import {
  pluginShellStreamRaw,
  MAX_PENDING_NEXT_RESOLVERS_FOR_TEST,
} from '../../../electron/preload/plugin-shell-stream.preload';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../../electron/shared/plugin-shell-stream-channels';

afterEach(() => {
  capturedHandler = null;
  invokeCalls.length = 0;
});

function fire(streamId: string, kind: string, payload: unknown): void {
  capturedHandler!({} as IpcRendererEvent, { streamId, kind, payload });
}

describe('race(R93) · shell-stream chunks 并发 next() FIFO 不丢等待者', () => {
  it('两个并发 next() → 两个 chunk 按 FIFO 各自 resolve(先发不挂死)', async () => {
    const { chunks } = pluginShellStreamRaw.execStream('cmd', []);
    const streamId = invokeCalls[0]![1] as string;
    const it = chunks[Symbol.asyncIterator]();

    // 队列空时并发两次 next() → 两个等待者入 FIFO 队列。
    const p1 = it.next();
    const p2 = it.next();

    // 两个 chunk 到达 → 按 FIFO 分别唤醒 p1、p2。
    fire(streamId, 'stdout', new Uint8Array([97])); // 'a'
    fire(streamId, 'stdout', new Uint8Array([98])); // 'b'

    const r1 = await p1;
    const r2 = await p2;
    expect(r1.done).toBe(false);
    expect(r2.done).toBe(false);
    expect(Array.from((r1.value as { chunk: Uint8Array }).chunk)).toEqual([97]);
    expect(Array.from((r2.value as { chunk: Uint8Array }).chunk)).toEqual([98]);
  });

  it('exit 唤醒所有 pending next() 为 done(不只最后一个)', async () => {
    const { chunks } = pluginShellStreamRaw.execStream('cmd', []);
    const streamId = invokeCalls[0]![1] as string;
    const it = chunks[Symbol.asyncIterator]();

    const p1 = it.next();
    const p2 = it.next();

    fire(streamId, 'exit', { exitCode: 0, signal: null });

    await expect(p1).resolves.toEqual({ value: undefined, done: true });
    await expect(p2).resolves.toEqual({ value: undefined, done: true });
  });

  it('FIFO 队列不通过 Array.shift 移动数组头部', async () => {
    const { chunks } = pluginShellStreamRaw.execStream('cmd', []);
    const streamId = invokeCalls[0]![1] as string;
    const it = chunks[Symbol.asyncIterator]();

    const p1 = it.next();
    const p2 = it.next();
    fire(streamId, 'stdout', new Uint8Array([97]));
    fire(streamId, 'stdout', new Uint8Array([98]));

    await expect(p1).resolves.toMatchObject({ done: false });
    await expect(p2).resolves.toMatchObject({ done: false });
    expect(pluginShellStreamRaw.execStream.toString()).not.toContain('.shift(');
  });

  // 边界(E231,E61 同族/E230 preload 侧):pending next() 等待者数量上限。无缓冲且未退出时海量 next()
  // 不 await 会无界 push resolver;超限视为滥用 → ABORT + 合成错误 exit 收敛全部等待者。
  it('E231 pending next() 超 MAX_PENDING_NEXT_RESOLVERS → ABORT + 合成 exit,全部收敛 done', async () => {
    const { chunks, done } = pluginShellStreamRaw.execStream('cmd', []);
    const it = chunks[Symbol.asyncIterator]();
    const max = MAX_PENDING_NEXT_RESOLVERS_FOR_TEST;

    // 凑满上限:max 个 next() 入 FIFO 等待队列(都不 await)。
    const pending: Promise<IteratorResult<unknown, unknown>>[] = [];
    for (let i = 0; i < max; i++) pending.push(it.next() as never);

    // 此刻不应触发 ABORT(刚好满,未超)。
    expect(
      invokeCalls.some((c) => c[0] === PLUGIN_SHELL_STREAM_CHANNELS.ABORT),
    ).toBe(false);

    // 第 max+1 个 next():超限 → ABORT 子进程 + 合成错误 exit,本次直接 done。
    const overflow = it.next();
    await expect(overflow).resolves.toEqual({ value: undefined, done: true });

    // 发了 ABORT(超限收口)。
    expect(
      invokeCalls.some((c) => c[0] === PLUGIN_SHELL_STREAM_CHANNELS.ABORT),
    ).toBe(true);

    // 合成 exit 唤醒之前所有 pending 等待者为 done(不泄漏挂死)。
    for (const p of pending) {
      await expect(p).resolves.toEqual({ value: undefined, done: true });
    }
    // done Promise 也收敛为合成错误 exit。
    await expect(done).resolves.toEqual({ exitCode: -1, signal: null });
  });
});
