import { describe, it, expect, beforeEach } from 'vitest';
import { useExplorerStore } from '../../stores/explorer.store';

beforeEach(() => {
  // 复位到初态(避免 spec 间互相污染)
  useExplorerStore.setState({
    activePath: null,
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
    search: '',
  });
});

describe('explorer.store · 初态', () => {
  it('字段默认值', () => {
    const s = useExplorerStore.getState();
    expect(s.activePath).toBeNull();
    expect(s.expandedPaths.size).toBe(0);
    expect(s.sort).toEqual({ by: 'name', reverse: false });
    expect(s.search).toBe('');
  });
});

describe('explorer.store · toggleExpand', () => {
  it('未展开 → 加入 expandedPaths', () => {
    useExplorerStore.getState().toggleExpand('/a');
    expect(useExplorerStore.getState().expandedPaths.has('/a')).toBe(true);
  });

  it('已展开 → 移除', () => {
    useExplorerStore.getState().toggleExpand('/a');
    useExplorerStore.getState().toggleExpand('/a');
    expect(useExplorerStore.getState().expandedPaths.has('/a')).toBe(false);
  });

  it('多个互不影响', () => {
    useExplorerStore.getState().toggleExpand('/a');
    useExplorerStore.getState().toggleExpand('/b');
    const s = useExplorerStore.getState();
    expect(s.expandedPaths.has('/a')).toBe(true);
    expect(s.expandedPaths.has('/b')).toBe(true);
  });

  it('返回新 Set 引用(防 React 误判 unchanged)', () => {
    const before = useExplorerStore.getState().expandedPaths;
    useExplorerStore.getState().toggleExpand('/a');
    const after = useExplorerStore.getState().expandedPaths;
    expect(before).not.toBe(after);
  });
});

describe('explorer.store · setSort / setSearch', () => {
  it('setSort 替换 sort', () => {
    useExplorerStore.getState().setSort({ by: 'mtime', reverse: true });
    expect(useExplorerStore.getState().sort).toEqual({ by: 'mtime', reverse: true });
  });

  it('setSearch 设字符串', () => {
    useExplorerStore.getState().setSearch('foo');
    expect(useExplorerStore.getState().search).toBe('foo');
  });

  it('setSearch 空串可设', () => {
    useExplorerStore.getState().setSearch('foo');
    useExplorerStore.getState().setSearch('');
    expect(useExplorerStore.getState().search).toBe('');
  });
});
