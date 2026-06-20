// topic 49 第十六轮 · P2-AS:窗口关闭时清理 titleCounter,防单调泄漏。
//
// 根因:每个窗口创建终端时 nextDefaultTitle 在 titleCounter 写一个 windowId→n 条目。
// 窗口关闭走 removeByOwner,旧实现只删 sessions、**不删 titleCounter**。BrowserWindow.id
// 单调递增不复用,故长生命周期内反复开关窗口 → titleCounter 永久增长、永不回收。
// 修复:removeByOwner 一并 titleCounter.delete(ownerWindowId)。
//
// 验证手段:removeByOwner 后对同 windowId 再 nextDefaultTitle 应从 1 重启(条目已删),
// 等价于断言该条目被回收。

import { afterEach, describe, expect, it } from 'vitest';
import {
  nextDefaultTitle,
  removeByOwner,
  _reset,
} from '../../../electron/main/services/terminal-sessions.service';

afterEach(() => {
  _reset();
});

describe('topic49 P2-AS · removeByOwner 清理 titleCounter', () => {
  it('removeByOwner 后同 windowId 的 titleCounter 被回收(再计数从 1 起)', () => {
    expect(nextDefaultTitle(7)).toBe('Terminal 1');
    expect(nextDefaultTitle(7)).toBe('Terminal 2');
    expect(nextDefaultTitle(7)).toBe('Terminal 3');

    // 窗口关闭
    removeByOwner(7);

    // 条目已删 → 再计数从 1 重启(证明 titleCounter 不泄漏)
    expect(nextDefaultTitle(7)).toBe('Terminal 1');
  });

  it('removeByOwner 即使该窗无活跃 session 也清掉 counter(early-return 之前)', () => {
    nextDefaultTitle(9); // 建过终端,计数器有条目;但 session 已被逐个 remove
    // 此时 sessions 里无 ownerWindowId=9 的条目 → removeByOwner 命中 early-return 分支
    removeByOwner(9);
    expect(nextDefaultTitle(9)).toBe('Terminal 1');
  });

  it('removeByOwner 只清自己窗口的 counter,不影响其它窗口', () => {
    nextDefaultTitle(1);
    nextDefaultTitle(1);
    nextDefaultTitle(2);
    removeByOwner(1);
    // 窗口 2 的计数器不受影响,继续递增
    expect(nextDefaultTitle(2)).toBe('Terminal 2');
  });
});
