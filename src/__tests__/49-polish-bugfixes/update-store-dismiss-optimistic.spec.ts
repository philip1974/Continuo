// topic 49 第十三轮 · P2-AG:更新成功后乐观摘除 available,关闭重复点击窗口。
//
// 根因:marketplace 更新按钮显示条件 `installed && updateAvailable && !pendingRestart`。
// 对已装插件做 in-place 更新成功后,onUpdate 只 `void refreshUpdates()`(异步)。在 refresh
// 完成前,updateByPid(=update-store.available)仍含旧版本 → 按钮继续显示且可点 → 用户可
// 对已是最新版的插件重复点击,触发二次 overwrite 安装(多一次 clone + staging swap)。
//
// 修复:update-store 加乐观 `dismiss(id)`,onUpdate 成功后立即摘除该 id 让按钮即时收起,
// 再异步 refresh 与磁盘对账。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  dismissAvailableUpdateFromList,
  useUpdateStore,
} from '../../marketplace/update-store';
import type { AvailableUpdate } from '../../marketplace/update-store';
import type { MarketplaceEntry } from '../../marketplace/types';

function entry(id: string): MarketplaceEntry {
  return {
    id,
    name: id,
    description: '',
    author: 'me',
    repo: `me/${id}`,
    branch: 'main',
    tags: [],
    verified: true,
  };
}

function avail(id: string, from = '1.0.0', to = '2.0.0'): AvailableUpdate {
  return { id, name: id, from, to, entry: entry(id) };
}

beforeEach(() => {
  useUpdateStore.setState({
    remoteVersions: new Map(),
    available: [avail('a'), avail('b')],
    checking: false,
    lastCheckedAt: null,
  });
});

describe('topic49 P2-AG · update-store.dismiss 乐观摘除', () => {
  it('dismissAvailableUpdateFromList 一次循环找目标并摘除,不走 find/filter', () => {
    const available = [avail('a'), avail('b'), avail('a', '1.0.0', '2.1.0')];
    const findSpy = vi.spyOn(Array.prototype, 'find');
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      const result = dismissAvailableUpdateFromList(available, 'a');
      const findCallsDuringDismiss = findSpy.mock.calls.length;
      const filterCallsDuringDismiss = filterSpy.mock.calls.length;
      expect(result).not.toBeNull();
      expect(result!.target.to).toBe('2.0.0');
      expect(result!.available.map((u) => u.id)).toEqual(['b']);
      expect(findCallsDuringDismiss).toBe(0);
      expect(filterCallsDuringDismiss).toBe(0);
      expect(dismissAvailableUpdateFromList.toString()).not.toContain(
        'next.push(',
      );
    } finally {
      findSpy.mockRestore();
      filterSpy.mockRestore();
    }
  });

  it('dismiss(id) 立即从 available 摘掉该条,保留其它', () => {
    useUpdateStore.getState().dismiss('a');
    const ids = useUpdateStore.getState().available.map((u) => u.id);
    expect(ids).toEqual(['b']);
  });

  it('dismiss 唯一更新时复用稳定空 available 列表', () => {
    const resultA = dismissAvailableUpdateFromList([avail('a')], 'a');
    const resultB = dismissAvailableUpdateFromList([avail('b')], 'b');

    expect(resultA).not.toBeNull();
    expect(resultB).not.toBeNull();
    expect(resultA!.available).toEqual([]);
    expect(resultA!.available).toBe(resultB!.available);
  });

  it('dismiss 不存在的 id → available 引用不变(no-op,无多余渲染)', () => {
    const before = useUpdateStore.getState().available;
    useUpdateStore.getState().dismiss('zzz');
    expect(useUpdateStore.getState().available).toBe(before);
  });

  it('dismiss 后该 id 不再出现在 available(按钮收起)', () => {
    useUpdateStore.getState().dismiss('a');
    expect(
      useUpdateStore.getState().available.some((u) => u.id === 'a'),
    ).toBe(false);
  });
});
