// @vitest-environment jsdom
// 打磨 R2(codex 性能):MarketplaceTab / PluginsTabContent 每秒轮询已装插件,
// listAll()/readIds() 每次返回新数组/Set → 无变化也整页 re-render。函数式更新
// 只在渲染态实际变化时换引用,无变化保持同引用让 React 跳过 re-render。
// 安全红线:samePluginList 不得掩盖 status/warning 变化(否则退化成 UI 陈旧态)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { PluginListItem } from '../../plugins/PluginManager';

const { managerRef } = vi.hoisted(() => ({
  managerRef: { current: null as null | { listAll: () => PluginListItem[] } },
}));
vi.mock('../../plugins/PluginManager', () => ({
  getUserPluginManager: () => managerRef.current,
}));

import { sameIdSet, useInstalledIds } from '../../marketplace/MarketplaceTab';
import { samePluginList } from '../../plugins/settings/PluginsTabContent';

function item(over: Partial<PluginListItem> & { id: string }): PluginListItem {
  return {
    id: over.id,
    manifest: over.manifest ?? ({ id: over.id } as PluginListItem['manifest']),
    status: over.status ?? 'enabled',
    error: over.error,
    warning: over.warning,
  };
}

beforeEach(() => {
  managerRef.current = null;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  cleanup();
});

describe('打磨 R2 — sameIdSet 纯比较', () => {
  it('成员相同 → true(顺序无关)', () => {
    expect(sameIdSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
  });
  it('新增/删除成员 → false', () => {
    expect(sameIdSet(new Set(['a']), new Set(['a', 'b']))).toBe(false);
    expect(sameIdSet(new Set(['a', 'b']), new Set(['a']))).toBe(false);
  });
});

describe('打磨 R2 — samePluginList 纯比较(不掩盖状态)', () => {
  it('完全相同 → true(manifest 同引用,模拟 listAll 返回稳定 manifest)', () => {
    const mf = { id: 'p1' } as PluginListItem['manifest'];
    const a = [item({ id: 'p1', manifest: mf })];
    const b = [item({ id: 'p1', manifest: mf })];
    expect(samePluginList(a, b)).toBe(true);
  });
  it('status 变化 → false(安全红线:必须触发 re-render)', () => {
    const mf = { id: 'p1' } as PluginListItem['manifest'];
    const a = [item({ id: 'p1', manifest: mf, status: 'disabled' })];
    const b = [item({ id: 'p1', manifest: mf, status: 'enabled' })];
    expect(samePluginList(a, b)).toBe(false);
  });
  it('warning(partial-grant ⚠)出现 → false', () => {
    const mf = { id: 'p1' } as PluginListItem['manifest'];
    const a = [item({ id: 'p1', manifest: mf })];
    const b = [item({ id: 'p1', manifest: mf, warning: 'partial' })];
    expect(samePluginList(a, b)).toBe(false);
  });
  it('长度变化 → false', () => {
    expect(samePluginList([item({ id: 'p1' })], [])).toBe(false);
  });
  it('manifest 引用变化(reload)→ false', () => {
    const m1 = { id: 'p1' } as PluginListItem['manifest'];
    const m2 = { id: 'p1' } as PluginListItem['manifest'];
    expect(
      samePluginList([item({ id: 'p1', manifest: m1 })], [item({ id: 'p1', manifest: m2 })]),
    ).toBe(false);
  });
});

describe('打磨 R2 — useInstalledIds 轮询引用稳定', () => {
  it('已装集合不变 → 轮询后返回同引用', () => {
    managerRef.current = { listAll: () => [item({ id: 'p1' }), item({ id: 'p2' })] };
    const { result } = renderHook(() => useInstalledIds());
    const first = result.current;
    expect(first.has('p1')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(3000); // 3 次轮询
    });
    expect(result.current).toBe(first); // 引用稳定 → 不 re-render
  });

  it('已装集合变化 → 轮询后换新引用', () => {
    let ids = ['p1'];
    managerRef.current = { listAll: () => ids.map((id) => item({ id })) };
    const { result } = renderHook(() => useInstalledIds());
    const first = result.current;

    act(() => {
      ids = ['p1', 'p2'];
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).not.toBe(first);
    expect(result.current.has('p2')).toBe(true);
  });
});
