// topic 49 · 审计 #3: 窗口关闭时,该窗口仍在 block 的 await_stop_hook 等待者
// 必须被立即取消(reject),而不是挂到 timeout_sec(最长 600s)才靠自身 timer 自愈。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHookFileBroker } from '../../../electron/main/services/mcp-tools-hook-bridge';
import { makeWindowClosedCleanup } from '../../../electron/main/ipc/terminal.ipc';

describe('topic 49 · broker.cancelByWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('取消指定窗口的 pending 等待者并 reject,返回取消数量', async () => {
    const broker = createHookFileBroker('/tmp/topic49-hook-events-a');
    // 不调 start() — awaitNext 在未 stop 时直接挂 pending(目录里无文件可匹配)。
    const p1 = broker.awaitNext({ windowId: 7, runner: 'cc', cwd: '/ws', timeoutMs: 600_000 });
    const p2 = broker.awaitNext({ windowId: 9, runner: 'cc', cwd: '/ws', timeoutMs: 600_000 });

    const rejected1 = p1.catch((e: Error) => e.message);

    const cancelled = broker.cancelByWindow(7);
    expect(cancelled).toBe(1);
    await expect(rejected1).resolves.toContain('window closed');

    // 别的窗口的等待者不受影响,仍 pending
    let p2settled = false;
    void p2.then(() => { p2settled = true; }).catch(() => { p2settled = true; });
    await Promise.resolve();
    expect(p2settled).toBe(false);

    // 清理: 取消窗口 9,避免悬空 promise
    broker.cancelByWindow(9);
    await p2.catch(() => {});
  });

  it('无匹配窗口时返回 0,不抛错', () => {
    const broker = createHookFileBroker('/tmp/topic49-hook-events-b');
    expect(broker.cancelByWindow(123)).toBe(0);
  });
});

describe('topic 49 · windowClosedCleanup 调用 cancelStopHookWaiters', () => {
  it('窗口关闭清理时,对该窗口 id 调一次 stop-hook 取消器', () => {
    const cancelStopHookWaiters = vi.fn();
    const cleanup = makeWindowClosedCleanup({
      service: { has: vi.fn(() => false), kill: vi.fn() } as never,
      sessionStore: { removeByOwner: vi.fn(() => []) } as never,
      cancelStopHookWaiters,
    });
    cleanup(42);
    expect(cancelStopHookWaiters).toHaveBeenCalledWith(42);
  });
});
