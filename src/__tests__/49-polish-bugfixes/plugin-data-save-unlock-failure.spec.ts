// topic 49 · P2-BH:plugin-data:save 的 finally 解锁失败不得掩盖一次成功的写。
//
// 根因:save handler 在 finally 里 `await release()`(proper-lockfile 解锁)。release()
// 本身可能 reject —— 锁 stale(>5s)被其它进程接管、或 .lock 目录被外部清掉时抛
// "Lock is not owned by you"。若 atomicWriteJson 已成功而 release() reject,finally 的
// reject 会覆盖成功结果 → 一次本已落盘成功的写被 IPC 报成失败(未闭环:成功却报错,
// 上层可能误触发重试 / 丢数据反馈)。修复:解锁 best-effort `.catch(() => {})`。

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lockMock = vi.hoisted(() => ({ lock: vi.fn() }));
vi.mock('proper-lockfile', () => ({ default: { lock: lockMock.lock } }));

import { PLUGIN_DATA_CHANNELS } from '../../../electron/shared/plugin-data-channels';
import { registerPluginDataStoreHandlers } from '../../../electron/main/services/plugin-data-store.service';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';

let userDataPath: string;
let ipc: StubIpcMain;

beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), `data-unlock-${randomUUID()}-`));
  ipc = new StubIpcMain();
  registerPluginDataStoreHandlers(ipc as never, { userDataPath });
  // lock() 成功获取,但 release() reject(模拟 stale 接管 / .lock 被清)
  lockMock.lock.mockResolvedValue(async () => {
    throw new Error('Lock is not owned by you');
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(userDataPath, { recursive: true, force: true });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return ipc.invokeWithEvent(makeFakeEvent(), channel, ...args);
}

describe('topic49 P2-BH · plugin-data:save 解锁失败不掩盖成功的写', () => {
  it('release() reject 但写已成功 → handler 仍 resolve 且数据已落盘', async () => {
    const data = { value: { n: 42 } };

    // 不应因 finally 里的 release() reject 而 reject
    await expect(
      invoke(PLUGIN_DATA_CHANNELS.SAVE, 'plugin.data', data),
    ).resolves.toBeUndefined();

    // 写确实落盘了
    const raw = await readFile(
      join(userDataPath, 'plugins', 'plugin.data', 'data.json'),
      'utf-8',
    );
    expect(JSON.parse(raw)).toEqual(data);
  });
});
