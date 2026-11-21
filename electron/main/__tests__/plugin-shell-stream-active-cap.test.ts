// 边界(E230,E227/E228/E229 数量上限族):流式 shell active 子进程并发数量上限。
// 用 mock 的 child_process.spawn(永不结束的 fake child),廉价、确定地验证全局/per-sender 双闸,
// 无需真起几十个 node 进程。真实 spawn 行为另由 plugin-shell-stream.test.ts(TDD)覆盖。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// fake child:stdout/stderr 是 EventEmitter,永不 emit 'close'/'error' → 一直驻留 active。
const spawnedChildren: FakeChild[] = [];
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  kill(_sig?: string): boolean {
    this.killed = true;
    return true;
  }
}

vi.mock('node:child_process', () => ({
  spawn: () => {
    const c = new FakeChild();
    spawnedChildren.push(c);
    return c;
  },
}));

import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../shared/plugin-shell-stream-channels';
import { ERROR_CODES } from '../../shared/error-codes';
import {
  registerPluginShellStreamHandlers,
  MAX_ACTIVE_STREAMS_GLOBAL_FOR_TEST,
  MAX_ACTIVE_STREAMS_PER_SENDER_FOR_TEST,
} from '../services/plugin-shell-stream.service';

type Handler = (
  event: { sender: MockWebContents; senderFrame?: { url: string } },
  ...args: unknown[]
) => Promise<void>;

let nextWcId = 1;
class MockWebContents {
  readonly id = nextWcId++;
  isDestroyed(): boolean {
    return false;
  }
  send(): void {}
  once(): void {}
  on(): void {}
}

class FakeIpcMain {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler);
  }
  invoke(sender: MockWebContents, channel: string, ...args: unknown[]): Promise<void> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler ${channel}`);
    return handler({ sender, senderFrame: { url: 'file:///app/index.html' } }, ...args);
  }
}

function makeHarness(): { ipc: FakeIpcMain } {
  const ipc = new FakeIpcMain();
  registerPluginShellStreamHandlers(ipc as never);
  return { ipc };
}

function start(ipc: FakeIpcMain, sender: MockWebContents, id: string): Promise<void> {
  return ipc.invoke(
    sender,
    PLUGIN_SHELL_STREAM_CHANNELS.START,
    id,
    'node',
    ['-e', 'setInterval(()=>{},1000)'],
  );
}

afterEach(() => {
  spawnedChildren.length = 0;
});

describe('plugin-shell-stream active 数量上限(E230)', () => {
  it('单 sender 凑满 per-sender 上限后,再 START 抛 TOO_MANY_STREAMS,不 spawn', async () => {
    const { ipc } = makeHarness();
    const sender = new MockWebContents();
    const max = MAX_ACTIVE_STREAMS_PER_SENDER_FOR_TEST;
    for (let i = 0; i < max; i++) {
      await start(ipc, sender, `s-${i}`);
    }
    expect(spawnedChildren.length).toBe(max);
    // 第 max+1 个:抛 TOO_MANY_STREAMS,不再 spawn
    const err = await start(ipc, sender, 'overflow').catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(ERROR_CODES.TOO_MANY_STREAMS);
    expect(spawnedChildren.length).toBe(max); // 没多 spawn
  });

  it('ABORT 释放一个槽位后,可再 START(计数随 active 增删自然维护)', async () => {
    const { ipc } = makeHarness();
    const sender = new MockWebContents();
    const max = MAX_ACTIVE_STREAMS_PER_SENDER_FOR_TEST;
    for (let i = 0; i < max; i++) await start(ipc, sender, `s-${i}`);
    // 满 → 溢出
    let err = await start(ipc, sender, 'of').catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(ERROR_CODES.TOO_MANY_STREAMS);
    // ABORT 一个释放槽位
    await ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.ABORT, 's-0');
    // 现在能再 START
    await expect(start(ipc, sender, 'revived')).resolves.toBeUndefined();
    expect(spawnedChildren.length).toBe(max + 1);
    // 再来一个又溢出
    err = await start(ipc, sender, 'of2').catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(ERROR_CODES.TOO_MANY_STREAMS);
  });

  it('per-sender 是 per-sender 的:sender1 满,sender2 仍可 START', async () => {
    const { ipc } = makeHarness();
    const sender1 = new MockWebContents();
    const sender2 = new MockWebContents();
    const max = MAX_ACTIVE_STREAMS_PER_SENDER_FOR_TEST;
    for (let i = 0; i < max; i++) await start(ipc, sender1, `a-${i}`);
    const err = await start(ipc, sender1, 'a-of').catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(ERROR_CODES.TOO_MANY_STREAMS);
    // sender2 不受影响
    await expect(start(ipc, sender2, 'b-0')).resolves.toBeUndefined();
  });

  it('全局上限:跨多 sender 累计到全局上限后,新 sender 也被全局闸拒', async () => {
    const { ipc } = makeHarness();
    const perSender = MAX_ACTIVE_STREAMS_PER_SENDER_FOR_TEST;
    const global = MAX_ACTIVE_STREAMS_GLOBAL_FOR_TEST;
    let filled = 0;
    while (filled < global) {
      const sender = new MockWebContents();
      const room = Math.min(perSender, global - filled);
      for (let i = 0; i < room; i++) {
        await start(ipc, sender, `g-${filled}`);
        filled += 1;
      }
    }
    expect(spawnedChildren.length).toBe(global);
    // 全新 sender(per-sender 计数为 0)也被全局闸拒
    const fresh = new MockWebContents();
    const err = await start(ipc, fresh, 'fresh').catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(ERROR_CODES.TOO_MANY_STREAMS);
    expect(spawnedChildren.length).toBe(global); // 没多 spawn
  });
});
