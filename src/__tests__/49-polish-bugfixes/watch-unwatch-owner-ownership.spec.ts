// topic 49 第十二 session · codex 复审 F3:owner-aware unwatch 必须校验该 owner 真持有 path。
//
// 根因:unwatch(path, ownerId) 旧实现只查 watchers.has(path) 就无条件 decrementRef,
// 不确认该 owner 是否真持有。触发:窗口 A 展开目录 P 时 creator(fs.watch) 因目录刚被删
// 同步抛 ENOENT → A 从未把 P 记进 ownerPaths,但 renderer 的 prevPathsRef 已含 P。之后
// 窗口 B 成功 watch 同路径 P(refCount 1,owner B)。A 折叠/关窗发来 unwatch(P, A) →
// 旧实现误减 B 的 refCount 直接 close B 的活跃 watcher → B 的 Explorer 静默失去该目录
// fs 事件(树 UI 陈旧直到重展/重载)。与既有 owner 记账机制(purgeOwnerAccounting)的意图
// 矛盾,是 unwatch 侧的漏网。
//
// 修:ownerId 给定时,仅当 ownerPaths.get(ownerId).get(path) > 0(该 owner 确实持有)才
// decrement,否则 no-op;ownerId 缺省保留旧无 owner 语义。

import { describe, it, expect, vi } from 'vitest';
import { createWatcherPool } from '../../../electron/main/ipc/fs/watch';

describe('topic49 codexF3 · owner-aware unwatch 校验持有', () => {
  it('A 的 watch 同步抛错(目录已删)后,A 的 unwatch 不得误减 B 的活跃 watcher', () => {
    const closes: string[] = [];
    let calls = 0;
    const creator = (path: string) => {
      calls += 1;
      if (calls === 1) throw new Error('ENOENT'); // 窗口 A 的 fs.watch(P) 同步抛
      return { close: () => closes.push(path) };
    };
    const pool = createWatcherPool(creator);

    const WIN_A = 1;
    const WIN_B = 2;
    // A 展开 P → watch 抛错(renderer fire-and-forget 忽略,但 prevPathsRef 已含 P)
    expect(() => pool.watch('/P', () => {}, WIN_A)).toThrow();
    expect(pool.has('/P')).toBe(false);

    // B 成功 watch 同路径 P
    pool.watch('/P', () => {}, WIN_B);
    expect(pool.has('/P')).toBe(true);

    // A 折叠/关窗 → unwatch(P, A):A 从未持有 P → 必须 no-op,B 的 watcher 存活
    pool.unwatch('/P', WIN_A);
    expect(pool.has('/P')).toBe(true);
    expect(closes).toEqual([]);

    // B 自己 unwatch → 现在才真正 close
    pool.unwatch('/P', WIN_B);
    expect(pool.has('/P')).toBe(false);
    expect(closes).toEqual(['/P']);
  });

  it('正常 refcount 不被破坏:A、B 都合法持有 P,各自 unwatch 才递减', () => {
    const close = vi.fn();
    const creator = () => ({ close });
    const pool = createWatcherPool(creator);

    pool.watch('/P', () => {}, 1); // A:refCount 1
    pool.watch('/P', () => {}, 2); // B:refCount 2(共享同 watcher)
    expect(pool.size()).toBe(1);

    pool.unwatch('/P', 1); // A 释放 → refCount 2→1,不 close
    expect(pool.has('/P')).toBe(true);
    expect(close).not.toHaveBeenCalled();

    pool.unwatch('/P', 2); // B 释放 → refCount 1→0,close
    expect(pool.has('/P')).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('unwatchByOwner 仍按真实持有批量释放(与单次 unwatch 一致)', () => {
    const close = vi.fn();
    const pool = createWatcherPool(() => ({ close }));
    pool.watch('/P', () => {}, 1);
    pool.watch('/Q', () => {}, 1);
    pool.watch('/P', () => {}, 2); // B 也持有 P
    pool.unwatchByOwner(1); // A 释放 P、Q
    expect(pool.has('/Q')).toBe(false); // Q 只有 A → close
    expect(pool.has('/P')).toBe(true); // P 还有 B → 存活
  });
});
