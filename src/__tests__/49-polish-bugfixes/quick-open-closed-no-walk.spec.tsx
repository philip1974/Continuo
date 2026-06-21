// @vitest-environment jsdom
// 打磨 R33(codex 性能,仿 R32):QuickOpenModal 拆 shell + body 后,关闭状态
// (isOpen=false)下不挂载 QuickOpenBody → 不订阅 results/query/root、不跑
// fuzzyFilter、不创建 virtualizer。仅打开时才挂载 body 并触发这些派生。
//
// 验证用 useVirtualizer:它是组件级 hook,**pre-R33 即使关闭(渲染 null)也会跑**
// (hooks 无条件执行);R33 后 body 不挂载 → 关闭时不再创建 virtualizer。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

const { virtualizerSpy } = vi.hoisted(() => ({ virtualizerSpy: vi.fn() }));
vi.mock('../../plugins/quick-open/walk-files', () => ({
  walkWorkspaceFiles: vi.fn(async () => ({ ok: true as const, data: [] })),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    virtualizerSpy(count);
    return {
      getTotalSize: () => count * 28,
      getVirtualItems: () => [],
      scrollToIndex: vi.fn(),
    };
  },
}));

import { QuickOpenModal } from '../../plugins/quick-open/QuickOpenModal';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { useWorkspaceStore } from '../../stores/workspace.store';

beforeEach(() => {
  virtualizerSpy.mockClear();
  useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
  useQuickOpenStore.setState({
    isOpen: false,
    query: '',
    selectedIndex: 0,
    results: [],
    loading: false,
    scanFailed: false,
  });
});
afterEach(() => cleanup());

describe('打磨 R33 — 关闭时不挂载 body / 不创建 virtualizer', () => {
  it('isOpen=false → body 不挂载,useVirtualizer 不被调用', () => {
    render(<QuickOpenModal />);
    expect(virtualizerSpy).not.toHaveBeenCalled();
    expect(document.querySelector('input')).toBeNull(); // 无搜索框 DOM
  });

  it('open() → body 挂载,创建 virtualizer + 渲染搜索框', () => {
    render(<QuickOpenModal />);
    expect(virtualizerSpy).not.toHaveBeenCalled();

    act(() => useQuickOpenStore.getState().open());
    expect(virtualizerSpy).toHaveBeenCalled();
    expect(document.querySelector('input')).not.toBeNull();
  });
});
