import { afterEach, describe, expect, it, vi } from 'vitest';

// 受控的 ipcRenderer mock:只需可切换 invoke 行为 + on/removeListener no-op。
let invokeImpl: (...a: unknown[]) => Promise<unknown> = () => Promise.resolve();
const invokeCalls: unknown[][] = [];
const removeListenerCalls: unknown[][] = [];

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (...a: unknown[]) => {
      invokeCalls.push(a);
      return invokeImpl(...a);
    },
    on: () => {},
    removeListener: (...a: unknown[]) => {
      removeListenerCalls.push(a);
    },
  },
}));

import { pluginShellStreamRaw } from '../../../electron/preload/plugin-shell-stream.preload';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../../electron/shared/plugin-shell-stream-channels';

afterEach(() => {
  invokeImpl = () => Promise.resolve();
  invokeCalls.length = 0;
  removeListenerCalls.length = 0;
});

// P2 回归:renderer 旧实现 `void ipcRenderer.invoke(START, ...)` 丢弃 rejection。
// 主进程在 spawn 之前就 reject(streamId 已占用是同步 throw)时永远不会回 'exit'
// 事件 → `done` 与 chunk 迭代器永久挂起,插件 `await done`/`for await` 死锁。
describe('49 · execStream START reject 不再永久挂起', () => {
  it('START 被 reject 时 done 收敛为合成 exit(exitCode -1)', async () => {
    invokeImpl = () => Promise.reject(new Error('streamId already active'));
    const { done } = pluginShellStreamRaw.execStream('git', ['status']);
    await expect(done).resolves.toEqual({ exitCode: -1, signal: null });
  });

  it('START reject 时 chunk 异步迭代器立即终止(done:true)而非永挂', async () => {
    invokeImpl = () => Promise.reject(new Error('boom'));
    const { chunks } = pluginShellStreamRaw.execStream('git', ['log']);
    const it = chunks[Symbol.asyncIterator]();
    await expect(it.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it('正常路径:START 成功 resolve 时不会被合成 exit 抢先 settle 成 -1', async () => {
    invokeImpl = () => Promise.resolve(undefined);
    const { done } = pluginShellStreamRaw.execStream('echo', ['hi']);
    await Promise.resolve();
    await Promise.resolve();
    // invoke 正常 resolve → 合成 exit 不触发,done 仍 pending(等真实 exit 事件)
    const settled = await Promise.race([
      done.then((v) => `exit:${v.exitCode}`),
      Promise.resolve('pending' as const),
    ]);
    expect(settled).toBe('pending');
  });

  // P2-AM 回归:消费方提前 break/return → iterator.return() 必须 invoke ABORT + 摘 listener,
  // 否则子进程挂到 timeout(最长 30min)、handler 驻留、chunkQueue 无界堆积。
  it('iterator.return() 发 ABORT + removeListener + done 收敛', async () => {
    invokeImpl = () => Promise.resolve(undefined);
    const { chunks, done } = pluginShellStreamRaw.execStream('tail', ['-f']);
    const it = chunks[Symbol.asyncIterator]();
    const r = await it.return!();
    expect(r).toEqual({ value: undefined, done: true });
    // 发了 ABORT(START + ABORT 两次 invoke,最后一次是 ABORT)
    const abort = invokeCalls.find(
      (c) => c[0] === PLUGIN_SHELL_STREAM_CHANNELS.ABORT,
    );
    expect(abort).toBeTruthy();
    expect(abort?.[1]).toEqual(expect.any(String)); // streamId
    // 摘了 EVENT listener
    expect(
      removeListenerCalls.some(
        (c) => c[0] === PLUGIN_SHELL_STREAM_CHANNELS.EVENT,
      ),
    ).toBe(true);
    // done 收敛(abort 视为终止),不永挂
    await expect(done).resolves.toEqual({ exitCode: null, signal: null });
  });

  it('return() 幂等:已结束(exitInfo)后再 return 不重复 ABORT', async () => {
    invokeImpl = () => Promise.reject(new Error('boom')); // START reject → synthesizeExit 设 exitInfo
    const { chunks } = pluginShellStreamRaw.execStream('git', ['log']);
    const it = chunks[Symbol.asyncIterator]();
    await it.next(); // 触发 synthesizeExit
    invokeCalls.length = 0;
    await it.return!();
    // exitInfo 已设 → return 不再发 ABORT
    expect(
      invokeCalls.some((c) => c[0] === PLUGIN_SHELL_STREAM_CHANNELS.ABORT),
    ).toBe(false);
  });
});
