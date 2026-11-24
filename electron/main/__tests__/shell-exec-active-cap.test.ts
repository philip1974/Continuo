// 终审 P1(E230 同族):一次性 shell.exec 在途子进程并发数量上限。插件循环调用 exec 不 await → 此前无限 spawn,
// 耗尽 PID / FD。与 plugin-shell-stream 同款全局 + 单 sender 双闸,spawn 前拒绝(TOO_MANY_STREAMS)。
// 用 mock 的 child_process.spawn(fake child,手动 emit close),廉价、确定地验证双闸与名额释放。

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

const spawnedChildren: FakeChild[] = [];

vi.mock('node:child_process', () => ({
  spawn: () => {
    const c = new FakeChild();
    spawnedChildren.push(c);
    return c;
  },
}));

import { ERROR_CODES } from '../../shared/error-codes';
import {
  execShell,
  MAX_ACTIVE_EXECS_GLOBAL_FOR_TEST,
  MAX_ACTIVE_EXECS_PER_SENDER_FOR_TEST,
} from '../services/shell.service';
import { FakeChild } from './_helpers/fake-child';

const input = { cmd: 'node', args: [], pluginId: 'com.x.p' };

afterEach(() => {
  // 结算全部在途 fake child,归还名额(模块级计数跨用例共享)。
  for (const c of spawnedChildren) c.emit('close', 0, null);
  spawnedChildren.length = 0;
});

describe('shell.exec 在途数量上限', () => {
  it('单 sender 凑满上限后,再 exec 被拒(TOO_MANY_STREAMS)且不 spawn', async () => {
    const max = MAX_ACTIVE_EXECS_PER_SENDER_FOR_TEST;
    for (let i = 0; i < max; i++) void execShell(input, 1);
    expect(spawnedChildren.length).toBe(max);
    const err = await execShell(input, 1).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(ERROR_CODES.TOO_MANY_STREAMS);
    expect(spawnedChildren.length).toBe(max);
    // 其它 sender 不受单 sender 闸影响
    void execShell(input, 2);
    expect(spawnedChildren.length).toBe(max + 1);
  });

  it('已完成(close)的 exec 释放名额,可再 exec', async () => {
    const max = MAX_ACTIVE_EXECS_PER_SENDER_FOR_TEST;
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < max; i++) pending.push(execShell(input, 3));
    spawnedChildren[0]!.emit('close', 0, null);
    await pending[0];
    void execShell(input, 3);
    expect(spawnedChildren.length).toBe(max + 1);
    const err = await execShell(input, 3).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(ERROR_CODES.TOO_MANY_STREAMS);
  });

  it('全局上限:跨多 sender 累计满后,新 sender 也被拒且不 spawn', async () => {
    const perSender = MAX_ACTIVE_EXECS_PER_SENDER_FOR_TEST;
    const global = MAX_ACTIVE_EXECS_GLOBAL_FOR_TEST;
    let filled = 0;
    let sender = 100;
    while (filled < global) {
      const room = Math.min(perSender, global - filled);
      for (let i = 0; i < room; i++, filled++) void execShell(input, sender);
      sender += 1;
    }
    expect(spawnedChildren.length).toBe(global);
    const err = await execShell(input, 999).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(ERROR_CODES.TOO_MANY_STREAMS);
    expect(spawnedChildren.length).toBe(global);
  });
});
