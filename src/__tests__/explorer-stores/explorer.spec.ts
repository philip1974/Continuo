import { describe, it, expect, beforeEach, vi } from 'vitest';
import { forgetInExpanded, renameInExpanded, useExplorerStore } from '../../stores/explorer.store';
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

// 路径已移走 / 已删除 → 展开集合同步(否则旧路径留在持久化的 expandedPaths:改名后新目录折叠,
// 刷新 / watcher 对旧路径 listDir / watchDir 反复失败,重启后依旧)。
describe('explorer.store · renameExpanded', () => {
  it('旧路径及其后代前缀替换为新路径,保留展开;同名前缀的兄弟不动', () => {
    useExplorerStore.getState().setExpandedPaths(['/r', '/r/foo', '/r/foo/a', '/r/foobar']);
    useExplorerStore.getState().renameExpanded('/r/foo', '/r/bar');
    expect(useExplorerStore.getState().expandedPaths).toEqual(
      new Set(['/r', '/r/bar', '/r/bar/a', '/r/foobar']),
    );
  });

  it('Windows 分隔符的后代也改写', () => {
    useExplorerStore.getState().setExpandedPaths(['C:\\r\\foo', 'C:\\r\\foo\\a']);
    useExplorerStore.getState().renameExpanded('C:\\r\\foo', 'C:\\r\\bar');
    expect(useExplorerStore.getState().expandedPaths).toEqual(
      new Set(['C:\\r\\bar', 'C:\\r\\bar\\a']),
    );
  });

  it('不涉及展开集合时引用不变、不通知订阅者', () => {
    useExplorerStore.getState().setExpandedPaths(['/r', '/r/a']);
    const before = useExplorerStore.getState().expandedPaths;
    const listener = vi.fn();
    const unsub = useExplorerStore.subscribe(listener);
    try {
      useExplorerStore.getState().renameExpanded('/r/x', '/r/y');
      expect(useExplorerStore.getState().expandedPaths).toBe(before);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsub();
    }
  });
});

describe('explorer.store · forgetExpanded', () => {
  it('删除路径及其后代,同名前缀的兄弟保留', () => {
    useExplorerStore
      .getState()
      .setExpandedPaths(['/r', '/r/foo', '/r/foo/a', '/r/foobar', '/r/x', 'C:\\w\\d', 'C:\\w\\d\\e']);
    useExplorerStore.getState().forgetExpanded(['/r/foo', '/r/x', 'C:\\w\\d']);
    expect(useExplorerStore.getState().expandedPaths).toEqual(new Set(['/r', '/r/foobar']));
  });

  it('无命中时引用不变、不通知订阅者', () => {
    useExplorerStore.getState().setExpandedPaths(['/r', '/r/a']);
    const before = useExplorerStore.getState().expandedPaths;
    const listener = vi.fn();
    const unsub = useExplorerStore.subscribe(listener);
    try {
      useExplorerStore.getState().forgetExpanded(['/r/zz']);
      expect(useExplorerStore.getState().expandedPaths).toBe(before);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsub();
    }
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

// 「全部展开」批量期暂存的展开数组批末整体写回 store:批量期间的改名 / 删除须对它同样改写(与 store 方法同一函数)。
describe('renameInExpanded / forgetInExpanded(纯函数)', () => {
  it('改写前缀;无命中 → null', () => {
    expect(renameInExpanded(['/r/foo', '/r/foo/a', '/r/foobar'], '/r/foo', '/r/bar')).toEqual([
      '/r/bar',
      '/r/bar/a',
      '/r/foobar',
    ]);
    expect(renameInExpanded(['/r/x'], '/r/foo', '/r/bar')).toBeNull();
  });
  it('移除路径及后代;无命中 → null', () => {
    expect(forgetInExpanded(['/r/foo', '/r/foo/a', '/r/foobar'], ['/r/foo'])).toEqual(['/r/foobar']);
    expect(forgetInExpanded(['/r/x'], ['/r/foo'])).toBeNull();
  });
});

