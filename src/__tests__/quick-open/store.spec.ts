// BDD: quick-open / store
// useQuickOpenStore 行为契约。

import { describe, it, expect, beforeEach } from 'vitest';
import { useQuickOpenStore } from '../../plugins/quick-open/store';

beforeEach(() => {
  useQuickOpenStore.setState({
    isOpen: false,
    query: '',
    selectedIndex: 0,
    results: [],
    loading: false,
  });
});

describe('useQuickOpenStore', () => {
  it('open() reset query / selectedIndex,isOpen=true', () => {
    useQuickOpenStore.setState({
      query: 'old',
      selectedIndex: 5,
      isOpen: false,
    });
    useQuickOpenStore.getState().open();
    const s = useQuickOpenStore.getState();
    expect(s.isOpen).toBe(true);
    expect(s.query).toBe('');
    expect(s.selectedIndex).toBe(0);
  });

  it('close() 仅 isOpen=false(results / query 保留供下次 reopen 秒响应)', () => {
    useQuickOpenStore.setState({
      isOpen: true,
      query: 'foo',
      results: [
        { absPath: '/a/b.ts', relPath: 'a/b.ts', name: 'b.ts' },
      ],
    });
    useQuickOpenStore.getState().close();
    const s = useQuickOpenStore.getState();
    expect(s.isOpen).toBe(false);
    expect(s.query).toBe('foo');
    expect(s.results).toHaveLength(1);
  });

  it('setQuery 更新 + reset selectedIndex', () => {
    useQuickOpenStore.setState({ query: 'a', selectedIndex: 7 });
    useQuickOpenStore.getState().setQuery('foo');
    const s = useQuickOpenStore.getState();
    expect(s.query).toBe('foo');
    expect(s.selectedIndex).toBe(0);
  });

  it('moveSelection 循环(到底跳头,到头跳尾)', () => {
    useQuickOpenStore.setState({ selectedIndex: 0 });
    useQuickOpenStore.getState().moveSelection(1, 3);
    expect(useQuickOpenStore.getState().selectedIndex).toBe(1);
    useQuickOpenStore.getState().moveSelection(1, 3);
    expect(useQuickOpenStore.getState().selectedIndex).toBe(2);
    useQuickOpenStore.getState().moveSelection(1, 3);
    expect(useQuickOpenStore.getState().selectedIndex).toBe(0); // wrap
    useQuickOpenStore.getState().moveSelection(-1, 3);
    expect(useQuickOpenStore.getState().selectedIndex).toBe(2); // wrap to tail
  });

  it('moveSelection max=0 → 不动', () => {
    useQuickOpenStore.setState({ selectedIndex: 0 });
    useQuickOpenStore.getState().moveSelection(1, 0);
    expect(useQuickOpenStore.getState().selectedIndex).toBe(0);
  });

  it('setResults / setLoading 独立写入', () => {
    const results = [{ absPath: '/a', relPath: 'a', name: 'a' }];
    useQuickOpenStore.getState().setResults(results);
    expect(useQuickOpenStore.getState().results).toEqual(results);
    useQuickOpenStore.getState().setLoading(true);
    expect(useQuickOpenStore.getState().loading).toBe(true);
  });
});
