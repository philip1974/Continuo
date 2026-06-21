import { describe, it, expect, beforeEach } from 'vitest';
import { useExplorerStore } from '../../stores/explorer.store';

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

describe('explorer.store · setExpandedPaths', () => {
  it('整体替换 expandedPaths,并返回新 Set 引用', () => {
    useExplorerStore.getState().toggleExpand('/old');
    const before = useExplorerStore.getState().expandedPaths;

    useExplorerStore.getState().setExpandedPaths(['/work', '/work/src']);

    const after = useExplorerStore.getState().expandedPaths;
    expect(after).toEqual(new Set(['/work', '/work/src']));
    expect(after).not.toBe(before);
  });
});

describe('explorer.store · setSort', () => {
  it('setSort 替换 sort', () => {
    useExplorerStore.getState().setSort({ by: 'mtime', reverse: true });
    expect(useExplorerStore.getState().sort).toEqual({ by: 'mtime', reverse: true });
  });
});
