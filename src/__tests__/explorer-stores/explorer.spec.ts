import { describe, it, expect, beforeEach } from 'vitest';
import { useExplorerStore } from '../../stores/explorer.store';

beforeEach(() => {
  // 复位到初态(避免 spec 间互相污染)
  useExplorerStore.setState({
    activePath: null,
    selectedPaths: new Set(),
    lastAnchorPath: null,
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
    search: '',
  });
});

describe('explorer.store · 初态', () => {
  it('字段默认值', () => {
    const s = useExplorerStore.getState();
    expect(s.activePath).toBeNull();
    expect(s.selectedPaths.size).toBe(0);
    expect(s.lastAnchorPath).toBeNull();
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

describe('explorer.store · selectSingle', () => {
  it('清空多选 + 设当前 + activePath/lastAnchor 跟', () => {
    useExplorerStore.setState({
      selectedPaths: new Set(['/x', '/y']),
      activePath: '/x',
      lastAnchorPath: '/x',
    });
    useExplorerStore.getState().selectSingle('/z');
    const s = useExplorerStore.getState();
    expect(s.selectedPaths).toEqual(new Set(['/z']));
    expect(s.activePath).toBe('/z');
    expect(s.lastAnchorPath).toBe('/z');
  });
});

describe('explorer.store · selectToggle', () => {
  it('不在选集 → 加入', () => {
    useExplorerStore.getState().selectToggle('/a');
    const s = useExplorerStore.getState();
    expect(s.selectedPaths.has('/a')).toBe(true);
    expect(s.activePath).toBe('/a');
    expect(s.lastAnchorPath).toBe('/a');
  });

  it('已在选集 → 移除', () => {
    useExplorerStore.setState({
      selectedPaths: new Set(['/a']),
      activePath: '/a',
      lastAnchorPath: '/a',
    });
    useExplorerStore.getState().selectToggle('/a');
    expect(useExplorerStore.getState().selectedPaths.has('/a')).toBe(false);
  });

  it('保持其它已选项', () => {
    useExplorerStore.setState({ selectedPaths: new Set(['/a', '/b']) });
    useExplorerStore.getState().selectToggle('/c');
    expect(useExplorerStore.getState().selectedPaths).toEqual(
      new Set(['/a', '/b', '/c']),
    );
  });
});

describe('explorer.store · selectRange', () => {
  const flat = ['/a', '/b', '/c', '/d', '/e'];

  it('lastAnchor=/a, click=/c → 选 a..c', () => {
    useExplorerStore.setState({ lastAnchorPath: '/a' });
    useExplorerStore.getState().selectRange('/c', flat);
    const s = useExplorerStore.getState();
    expect(s.selectedPaths).toEqual(new Set(['/a', '/b', '/c']));
    expect(s.activePath).toBe('/c');
    expect(s.lastAnchorPath).toBe('/a'); // anchor 不动
  });

  it('lastAnchor=/d, click=/b → 选 b..d(逆向)', () => {
    useExplorerStore.setState({ lastAnchorPath: '/d' });
    useExplorerStore.getState().selectRange('/b', flat);
    expect(useExplorerStore.getState().selectedPaths).toEqual(
      new Set(['/b', '/c', '/d']),
    );
  });

  it('替换原有选集(非追加)', () => {
    useExplorerStore.setState({
      selectedPaths: new Set(['/x', '/y']),
      lastAnchorPath: '/a',
    });
    useExplorerStore.getState().selectRange('/b', flat);
    expect(useExplorerStore.getState().selectedPaths).toEqual(
      new Set(['/a', '/b']),
    );
  });

  it('lastAnchor 不在 flat 中 → 退化为 selectSingle', () => {
    useExplorerStore.setState({ lastAnchorPath: '/not-in-flat' });
    useExplorerStore.getState().selectRange('/c', flat);
    const s = useExplorerStore.getState();
    expect(s.selectedPaths).toEqual(new Set(['/c']));
    expect(s.lastAnchorPath).toBe('/c');
  });

  it('path 不在 flat → 退化为 selectSingle', () => {
    useExplorerStore.setState({ lastAnchorPath: '/a' });
    useExplorerStore.getState().selectRange('/missing', flat);
    expect(useExplorerStore.getState().selectedPaths).toEqual(
      new Set(['/missing']),
    );
  });

  it('lastAnchor 为 null → 退化为 selectSingle', () => {
    useExplorerStore.setState({ lastAnchorPath: null });
    useExplorerStore.getState().selectRange('/c', flat);
    expect(useExplorerStore.getState().selectedPaths).toEqual(new Set(['/c']));
  });
});

describe('explorer.store · clearSelection', () => {
  it('selectedPaths 清空,activePath 不动', () => {
    useExplorerStore.setState({
      selectedPaths: new Set(['/a', '/b']),
      activePath: '/a',
    });
    useExplorerStore.getState().clearSelection();
    const s = useExplorerStore.getState();
    expect(s.selectedPaths.size).toBe(0);
    expect(s.activePath).toBe('/a');
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
