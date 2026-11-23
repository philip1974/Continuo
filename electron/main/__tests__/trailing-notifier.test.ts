import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrailingNotifier } from '../lib/trailing-notifier';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createTrailingNotifier · 窗口期内多次变更只通知一次', () => {
  it('连续 notify 在 delay 窗口内合并为一次尾随调用', () => {
    const fn = vi.fn();
    const n = createTrailingNotifier(fn, 50);
    for (let i = 0; i < 10; i++) n.notify();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('窗口结束后的新变更再通知一次', () => {
    const fn = vi.fn();
    const n = createTrailingNotifier(fn, 50);
    n.notify();
    vi.advanceTimersByTime(50);
    n.notify();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('首次 notify 起算,持续变更不会无限推迟(最长 delay 后必发)', () => {
    const fn = vi.fn();
    const n = createTrailingNotifier(fn, 50);
    n.notify();
    vi.advanceTimersByTime(40);
    n.notify();
    vi.advanceTimersByTime(10);
    expect(fn).toHaveBeenCalledTimes(1);
  });

});

describe('接线 · plugin MCP tools/list_changed 经尾随合并广播', () => {
  it('plugin-mcp.ipc 的 notifyToolsChanged 走 createTrailingNotifier,不再逐次直接广播', async () => {
    const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const path = await vi.importActual<typeof import('node:path')>('node:path');
    const src = readFileSync(path.resolve(__dirname, '../ipc/plugin-mcp.ipc.ts'), 'utf8');
    expect(src).toMatch(/createTrailingNotifier\(/);
    expect(src).toMatch(/notifyToolsChanged:\s*\(\)\s*=>\s*toolsChanged\.notify\(\)/);
  });
});
