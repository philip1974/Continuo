// BDD: quick-open / store
// useQuickOpenStore 行为契约。

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
        { absPath: '/a/b.ts', relPath: 'a/b.ts', relPathLower: 'a/b.ts', name: 'b.ts' },
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

  it('关闭态 close() 不重复通知订阅者', () => {
    const listener = vi.fn();
    const unsubscribe = useQuickOpenStore.subscribe(listener);

    try {
      useQuickOpenStore.getState().close();

      expect(useQuickOpenStore.getState().isOpen).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('query 和 selectedIndex 都不变时 setQuery 不通知订阅者', () => {
    useQuickOpenStore.setState({ query: 'foo', selectedIndex: 0 });
    const listener = vi.fn();
    const unsubscribe = useQuickOpenStore.subscribe(listener);

    try {
      useQuickOpenStore.getState().setQuery('foo');

      expect(useQuickOpenStore.getState().query).toBe('foo');
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('setResults / setLoading 独立写入', () => {
    const results = [{ absPath: '/a', relPath: 'a', relPathLower: 'a', name: 'a' }];
    useQuickOpenStore.getState().setResults(results);
    expect(useQuickOpenStore.getState().results).toEqual(results);
    useQuickOpenStore.getState().setLoading(true);
    expect(useQuickOpenStore.getState().loading).toBe(true);
  });

  it('setResults 写入相同 results 引用和 root 时不通知订阅者', () => {
    const results = [{ absPath: '/a', relPath: 'a', relPathLower: 'a', name: 'a' }];
    useQuickOpenStore.setState({ results, resultsRoot: '/work' });
    const listener = vi.fn();
    const unsubscribe = useQuickOpenStore.subscribe(listener);

    try {
      useQuickOpenStore.getState().setResults(results, '/work');

      expect(useQuickOpenStore.getState().results).toBe(results);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('setResults 写入相同内容的新数组和相同 root 时不通知订阅者', () => {
    const results = [{ absPath: '/a', relPath: 'a', relPathLower: 'a', name: 'a' }];
    const sameResults = [{ absPath: '/a', relPath: 'a', relPathLower: 'a', name: 'a' }];
    useQuickOpenStore.setState({ results, resultsRoot: '/work' });
    const listener = vi.fn();
    const unsubscribe = useQuickOpenStore.subscribe(listener);

    try {
      useQuickOpenStore.getState().setResults(sameResults, '/work');

      expect(useQuickOpenStore.getState().results).toBe(results);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('setLoading / setScanFailed 写入相同值时不通知订阅者', () => {
    useQuickOpenStore.setState({ loading: true, scanFailed: true });
    const listener = vi.fn();
    const unsubscribe = useQuickOpenStore.subscribe(listener);

    try {
      useQuickOpenStore.getState().setLoading(true);
      useQuickOpenStore.getState().setScanFailed(true);

      expect(useQuickOpenStore.getState().loading).toBe(true);
      expect(useQuickOpenStore.getState().scanFailed).toBe(true);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  // race(R48):列表异步变短(setResults 替换 / query 收窄)时 selectedIndex 须钳回 [0,len-1],
  // 防 Enter 读 filtered[idx]=undefined 打开失效 + 高亮停越界项。
  describe('clampSelection(R48)', () => {
    it('selectedIndex 越界 → 钳到末项', () => {
      useQuickOpenStore.setState({ selectedIndex: 50 });
      useQuickOpenStore.getState().clampSelection(10); // 新列表只有 10 项
      expect(useQuickOpenStore.getState().selectedIndex).toBe(9);
    });

    it('空列表 → 钳到 0', () => {
      useQuickOpenStore.setState({ selectedIndex: 7 });
      useQuickOpenStore.getState().clampSelection(0);
      expect(useQuickOpenStore.getState().selectedIndex).toBe(0);
    });

    it('在范围内 → 不变', () => {
      useQuickOpenStore.setState({ selectedIndex: 3 });
      useQuickOpenStore.getState().clampSelection(10);
      expect(useQuickOpenStore.getState().selectedIndex).toBe(3);
    });

    it('在范围内 → 不通知订阅者', () => {
      useQuickOpenStore.setState({ selectedIndex: 3 });
      const listener = vi.fn();
      const unsubscribe = useQuickOpenStore.subscribe(listener);

      try {
        useQuickOpenStore.getState().clampSelection(10);

        expect(useQuickOpenStore.getState().selectedIndex).toBe(3);
        expect(listener).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });

    it('恰在末项边界(len-1)→ 不变', () => {
      useQuickOpenStore.setState({ selectedIndex: 9 });
      useQuickOpenStore.getState().clampSelection(10);
      expect(useQuickOpenStore.getState().selectedIndex).toBe(9);
    });
  });
});
