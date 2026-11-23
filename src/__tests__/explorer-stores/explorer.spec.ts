import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useExplorerStore } from '../../stores/explorer.store';
import {
  PATH_ARRAY_MAX,
  PATH_STR_MAX,
} from '../../../electron/shared/explorer-persistence-schema';

beforeEach(() => {
  // 复位到初态(避免 spec 间互相污染)
  useExplorerStore.setState({
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
  });
});

describe('explorer.store · 初态', () => {
  it('字段默认值', () => {
    const s = useExplorerStore.getState();
    expect(s.expandedPaths.size).toBe(0);
    expect(s.sort).toEqual({ by: 'name', reverse: false });
  });
});

describe('explorer.store · setExpandedPaths', () => {
  it('整体替换 expandedPaths,并返回新 Set 引用', () => {
    useExplorerStore.getState().setExpandedPaths(['/old']);
    const before = useExplorerStore.getState().expandedPaths;

    useExplorerStore.getState().setExpandedPaths(['/work', '/work/src']);

    const after = useExplorerStore.getState().expandedPaths;
    expect(after).toEqual(new Set(['/work', '/work/src']));
    expect(after).not.toBe(before);
  });

  it('setExpandedPaths 内容未变化时保持 Set 同引用且不通知订阅者', () => {
    const expandedPaths = new Set(['/work', '/work/src']);
    useExplorerStore.setState({ expandedPaths });
    const listener = vi.fn();
    const unsubscribe = useExplorerStore.subscribe(listener);

    try {
      useExplorerStore.getState().setExpandedPaths(['/work', '/work/src']);

      expect(useExplorerStore.getState().expandedPaths).toBe(expandedPaths);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('setExpandedPaths 传入当前 Set 引用时直接早退,不遍历源集合', () => {
    const expandedPaths = new Set(['/work', '/work/src']);
    useExplorerStore.setState({ expandedPaths });
    const valuesSpy = vi.spyOn(expandedPaths, Symbol.iterator);

    try {
      useExplorerStore.getState().setExpandedPaths(expandedPaths);

      expect(useExplorerStore.getState().expandedPaths).toBe(expandedPaths);
      expect(valuesSpy).not.toHaveBeenCalled();
    } finally {
      valuesSpy.mockRestore();
    }
  });

  it('setExpandedPaths 清空时复用稳定空 Set', () => {
    useExplorerStore.getState().setExpandedPaths(['/work']);
    useExplorerStore.getState().setExpandedPaths([]);
    const empty = useExplorerStore.getState().expandedPaths;

    useExplorerStore.getState().setExpandedPaths(['/other']);
    useExplorerStore.getState().setExpandedPaths([]);

    expect(useExplorerStore.getState().expandedPaths).toBe(empty);
  });

  // 边界(E277,E276 同族 / 运行时状态守持久化契约):expandedPaths 不得超持久化 schema(PATH_ARRAY_MAX 条
  // + 单条 ≤ PATH_STR_MAX),否则 explorer:write 拒整份 → 全 explorer 持久化失败。
  it('E277 setExpandedPaths 超 PATH_ARRAY_MAX → 截断到上限', () => {
    const many = Array.from({ length: PATH_ARRAY_MAX + 50 }, (_, i) => `/p${i}`);
    useExplorerStore.getState().setExpandedPaths(many);
    expect(useExplorerStore.getState().expandedPaths.size).toBe(PATH_ARRAY_MAX);
  });

  it('E277 setExpandedPaths 过滤超长 path', () => {
    const longPath = '/' + 'x'.repeat(PATH_STR_MAX);
    useExplorerStore.getState().setExpandedPaths(['/ok', longPath]);
    const s = useExplorerStore.getState().expandedPaths;
    expect(s.has('/ok')).toBe(true);
    expect(s.has(longPath)).toBe(false);
  });

});

describe('explorer.store · setSort', () => {
  it('setSort 替换 sort', () => {
    useExplorerStore.getState().setSort({ by: 'mtime', reverse: true });
    expect(useExplorerStore.getState().sort).toEqual({ by: 'mtime', reverse: true });
  });

  it('setSort 设置相同值时 no-op,不触发订阅', () => {
    const listener = vi.fn();
    const unsub = useExplorerStore.subscribe(listener);

    try {
      useExplorerStore.getState().setSort({ by: 'name', reverse: false });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsub();
    }
  });
});
