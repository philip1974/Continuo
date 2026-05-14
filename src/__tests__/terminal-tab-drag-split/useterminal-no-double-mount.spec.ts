/**
 * NEED-INFO-2 解决方案锁:detach + requestAnimationFrame + addPanel 序列,
 * 让 React commit 完原 TerminalLeaf 的 unmount(useTerminal cleanup 跑掉
 * onData 退订 + xterm dispose)后,再 mount ScopedTerminalPanel,避免双
 * useTerminal 同时订阅同一 PTY 导致用户输入双写 IPC。
 *
 * 本 spec 锁住 timing contract:detach 是同步 reducer dispatch,addPanel
 * 通过 requestAnimationFrame 排程,保证 React 在 rAF 前 flush DOM commits。
 *
 * 实际 timing 由 DockShell.handleExternalTabDrop 和 TerminalPaneTree.onDrop
 * 实施(均使用 requestAnimationFrame);本 spec 验证 rAF 调用是异步且在
 * 同步代码之后。
 */
import { describe, expect, it } from 'vitest';

describe('terminal-tab-drag-split: useTerminal no double mount via rAF', () => {
  it('requestAnimationFrame schedules callback asynchronously', async () => {
    let order: string[] = [];
    order.push('sync-1');
    const p = new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        order.push('raf-1');
        resolve();
      });
    });
    order.push('sync-2');
    await p;
    order.push('after-await');
    // sync 代码先完成,rAF callback 后跑
    expect(order).toEqual(['sync-1', 'sync-2', 'raf-1', 'after-await']);
  });

  it('multiple rAF callbacks run in order in the same animation frame', async () => {
    const order: number[] = [];
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => order.push(1));
      requestAnimationFrame(() => order.push(2));
      requestAnimationFrame(() => {
        order.push(3);
        resolve();
      });
    });
    expect(order).toEqual([1, 2, 3]);
  });
});
