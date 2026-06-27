// @vitest-environment jsdom
// 打磨 R25(codex 性能):Quick Open 列表虚拟化 —— 只渲染 virtualizer 给的可视
// 窗口行,而非把 filtered 全集一次性 map 成 <li>。本测试用一个"只返回固定 3 行
// 窗口"的 virtualizer mock + 100 条结果,证明组件渲染的是 getVirtualItems() 的
// 窗口(3 行)而非全部 100 行;并验证键盘移动会调 scrollToIndex。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

vi.mock('../../plugins/quick-open/walk-files', () => ({
  walkWorkspaceFiles: vi.fn(async () => ({ ok: true as const, data: [] })),
}));

const { scrollToIndexSpy, virtualizerSpy } = vi.hoisted(() => ({
  scrollToIndexSpy: vi.fn(),
  virtualizerSpy: vi.fn(),
}));
// 固定 3 行窗口(index 0..2),不随 count 变 —— 用来证明组件只渲染窗口。
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => {
    virtualizerSpy(opts.count);
    return {
      getTotalSize: () => opts.count * 28,
      getVirtualItems: () =>
        [0, 1, 2]
          .filter((i) => i < opts.count)
          .map((i) => ({ index: i, start: i * 28, size: 28, key: i })),
      scrollToIndex: scrollToIndexSpy,
    };
  },
}));

import {
  QuickOpenModal,
  isVirtualIndexRendered,
} from '../../plugins/quick-open/QuickOpenModal';
import { useQuickOpenStore, type QuickOpenFile } from '../../plugins/quick-open/store';
import { useWorkspaceStore } from '../../stores/workspace.store';

function mkFiles(n: number): QuickOpenFile[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `file${i}.ts`,
    relPath: `src/file${i}.ts`,
    relPathLower: `src/file${i}.ts`,
    absPath: `/work/src/file${i}.ts`,
  }));
}

beforeEach(() => {
  scrollToIndexSpy.mockClear();
  virtualizerSpy.mockClear();
  useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
  useQuickOpenStore.setState({
    isOpen: true,
    query: '',
    selectedIndex: 0,
    results: mkFiles(100),
    // race(R2):results 绑定当前 root,否则 liveResults 守卫视为跨 root 旧结果而过滤掉。
    resultsRoot: '/work',
    loading: false,
    scanFailed: false,
  });
});
afterEach(() => cleanup());

describe('打磨 R25 — Quick Open 虚拟化', () => {
  it('active option 渲染窗口判断用单趟循环,不调用 virtualItems.some', () => {
    const rows = [
      { index: 0, start: 0, size: 28, key: 0 },
      { index: 1, start: 28, size: 28, key: 1 },
    ];
    const someSpy = vi.spyOn(rows, 'some');

    try {
      expect(isVirtualIndexRendered(rows, 1)).toBe(true);
      expect(isVirtualIndexRendered(rows, 3)).toBe(false);
      expect(someSpy).not.toHaveBeenCalled();
    } finally {
      someSpy.mockRestore();
    }
  });

  it('100 条结果 → 只渲染 virtualizer 窗口(3 行),不是全部 100 行', () => {
    const { container } = render(<QuickOpenModal />);
    const options = container.querySelectorAll('[role=option]');
    expect(options.length).toBe(3); // 窗口内 3 行,而非 100
  });

  it('virtualizer count = filtered 全集(逻辑全集仍是 100)', () => {
    render(<QuickOpenModal />);
    expect(virtualizerSpy).toHaveBeenCalledWith(100);
  });

  it('键盘下移 → 调 scrollToIndex 跟随选中行', () => {
    const { container } = render(<QuickOpenModal />);
    const input = container.querySelector('input')!;
    act(() => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    expect(scrollToIndexSpy).toHaveBeenCalled();
  });
});
