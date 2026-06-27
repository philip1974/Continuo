// @vitest-environment jsdom
// race(R43):in-flight spawn 被取消后,迟到的 terminal.create 成功结果须清掉 main 侧已建的孤儿
// PTY。此前取消分支 `await coApi.terminal.remove(id)` 无 try/catch:remove IPC reject → run()
// 产生未处理 rejection;orphan 分支 void remove 不检查 ok:false → 静默漏清。统一抽 removeOrphanPty
// (await + 内部 catch + 检查 ok:false,不抛),两分支共用。本测试经取消分支覆盖该 helper。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  notifyError: vi.fn(),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: { terminal: { create: h.create, remove: h.remove } },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));

import { createSpawnQueue, type SpawnRequest } from '../../panels/Terminal/spawnLeaf';

function makeReq(over: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    tabId: 't1',
    leafId: 'l1',
    scoped: false,
    reason: 'split',
    cancelled: { current: false },
    ...over,
  };
}

beforeEach(() => {
  h.create.mockReset();
  h.remove.mockReset();
  h.notifyError.mockReset();
});

describe('race(R43) · 取消/orphan spawn 的 remove 清理不抛、失败可见', () => {
  it('cancelled + remove reject → 不产生未处理 rejection,孤儿 id 记入 removedPtyIds', async () => {
    h.create.mockResolvedValue({ ok: true, data: { id: 'pty-1' } });
    h.remove.mockRejectedValue(new Error('remove ipc down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const removed = new Set<string>();
    const queue = createSpawnQueue(vi.fn(), removed, 'terminal-panelR43a');
    const cancelled = { current: false };
    queue.enqueue(makeReq({ cancelled }));
    cancelled.current = true; // create 往返期间取消

    await vi.waitFor(() => expect(h.remove).toHaveBeenCalledWith('pty-1'));
    await vi.waitFor(() => expect(removed.has('pty-1')).toBe(true));
    // remove reject 被内部 catch(可见日志),不冒泡成 run() 未处理 rejection。
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('remove rejected'),
      'pty-1',
      expect.anything(),
    );
    warn.mockRestore();
  });

  it('cancelled + remove ok:false → 检查并记录失败,不抛', async () => {
    h.create.mockResolvedValue({ ok: true, data: { id: 'pty-2' } });
    h.remove.mockResolvedValue({ ok: false, code: 'TERMINAL_NOT_FOUND' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const removed = new Set<string>();
    const queue = createSpawnQueue(vi.fn(), removed, 'terminal-panelR43b');
    const cancelled = { current: false };
    queue.enqueue(makeReq({ cancelled }));
    cancelled.current = true;

    await vi.waitFor(() => expect(h.remove).toHaveBeenCalledWith('pty-2'));
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('remove ok=false'),
        'pty-2',
        expect.anything(),
      ),
    );
    expect(removed.has('pty-2')).toBe(true);
    warn.mockRestore();
  });

  it('cancelled + remove ok → 正常清理,无 warn', async () => {
    h.create.mockResolvedValue({ ok: true, data: { id: 'pty-3' } });
    h.remove.mockResolvedValue({ ok: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const removed = new Set<string>();
    const queue = createSpawnQueue(vi.fn(), removed, 'terminal-panelR43c');
    const cancelled = { current: false };
    queue.enqueue(makeReq({ cancelled }));
    cancelled.current = true;

    await vi.waitFor(() => expect(h.remove).toHaveBeenCalledWith('pty-3'));
    expect(removed.has('pty-3')).toBe(true);
    // 成功路径无 remove 失败告警。
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes('remove')),
    ).toHaveLength(0);
    warn.mockRestore();
  });
});
