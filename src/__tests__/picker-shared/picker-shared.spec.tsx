// @vitest-environment jsdom
// 重构守卫:CommandPalette / QuickOpen 共享的 picker 切片与列表 hook(行为契约 + 接线)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { create } from 'zustand';

const { scrollToIndexSpy, windowSize } = vi.hoisted(() => ({
  scrollToIndexSpy: vi.fn(),
  windowSize: { value: 3 },
}));
// 固定窗口(index 0..windowSize-1):证明 hook 只对渲染窗口内的选中项给 aria-activedescendant。
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => opts.count * opts.estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: Math.min(windowSize.value, opts.count) }, (_, i) => ({
        index: i,
        start: i * opts.estimateSize(),
        size: opts.estimateSize(),
        key: i,
      })),
    scrollToIndex: scrollToIndexSpy,
  }),
}));

import { createPickerSlice, type PickerSlice } from '../../plugins/picker/picker-slice';
import { isVirtualIndexRendered, usePickerList } from '../../plugins/picker/use-picker-list';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { MAX_SEARCH_QUERY_LEN } from '../../lib/search-query';

afterEach(() => cleanup());

describe('createPickerSlice', () => {
  const makeStore = () => create<PickerSlice>((set) => createPickerSlice(set));

  it('open 重置 query / 选中行;close 只关闭', () => {
    const store = makeStore();
    store.setState({ query: 'abc', selectedIndex: 4 });
    store.getState().open();
    expect(store.getState()).toMatchObject({ isOpen: true, query: '', selectedIndex: 0 });
    store.getState().setQuery('x');
    store.getState().close();
    expect(store.getState()).toMatchObject({ isOpen: false, query: 'x' });
  });

  it('setQuery 截断超长 query 并把选中行归 0', () => {
    const store = makeStore();
    store.setState({ selectedIndex: 3 });
    store.getState().setQuery('a'.repeat(MAX_SEARCH_QUERY_LEN + 50));
    expect(store.getState().query.length).toBe(MAX_SEARCH_QUERY_LEN);
    expect(store.getState().selectedIndex).toBe(0);
  });

  it('moveSelection 循环;max<=0 归 0', () => {
    const store = makeStore();
    store.getState().moveSelection(-1, 3);
    expect(store.getState().selectedIndex).toBe(2);
    store.getState().moveSelection(1, 3);
    expect(store.getState().selectedIndex).toBe(0);
    store.setState({ selectedIndex: 2 });
    store.getState().moveSelection(1, 0);
    expect(store.getState().selectedIndex).toBe(0);
  });

  it('clampSelection 钳到 [0, len-1]', () => {
    const store = makeStore();
    store.setState({ selectedIndex: 9 });
    store.getState().clampSelection(4);
    expect(store.getState().selectedIndex).toBe(3);
    store.getState().clampSelection(0);
    expect(store.getState().selectedIndex).toBe(0);
  });

  it('无变化时不通知订阅者', () => {
    const store = makeStore();
    store.getState().open();
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().open();
    store.getState().setQuery('');
    store.getState().moveSelection(1, 1);
    store.getState().clampSelection(5);
    expect(listener).not.toHaveBeenCalled();
    store.getState().close();
    store.getState().close();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('两个真实 store 都暴露切片的全部 action', () => {
    for (const state of [useCommandPaletteStore.getState(), useQuickOpenStore.getState()]) {
      for (const k of ['open', 'close', 'setQuery', 'moveSelection', 'clampSelection'] as const) {
        expect(state[k]).toBeTypeOf('function');
      }
    }
  });
});

interface HarnessProps {
  count: number;
  selectedIndex: number;
  moveSelection?: (delta: number, max: number) => void;
  clampSelection?: (len: number) => void;
  onEnter?: (index: number) => void;
}

const noop = (): void => {};

function Harness(props: HarnessProps) {
  const { scrollRef, virtualItems, comboboxProps, listboxProps, getOptionProps } = usePickerList({
    idPrefix: 'demo',
    count: props.count,
    selectedIndex: props.selectedIndex,
    rowHeight: 20,
    overscan: 2,
    moveSelection: props.moveSelection ?? noop,
    clampSelection: props.clampSelection ?? noop,
    onEnter: props.onEnter ?? noop,
  });
  return (
    <div>
      {/* 测试夹具:原生 input 仅用于承接 combobox props,不是产品 UI。 */}
      <input data-testid="input" {...comboboxProps} />
      <div ref={scrollRef}>
        {props.count > 0 && (
          <ul {...listboxProps}>
            {virtualItems.map((row) => (
              <li key={row.key} {...getOptionProps(row)}>
                row {row.index}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

describe('usePickerList', () => {
  beforeEach(() => {
    scrollToIndexSpy.mockClear();
    windowSize.value = 3;
  });

  it('combobox / listbox / option 的 ARIA 接线', () => {
    const { getByTestId, getByRole, getAllByRole } = render(<Harness count={10} selectedIndex={1} />);
    const input = getByTestId('input');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe('demo-listbox');
    expect(input.getAttribute('aria-activedescendant')).toBe('demo-option-1');

    const listbox = getByRole('listbox');
    expect(listbox.id).toBe('demo-listbox');
    expect(listbox.style.height).toBe('200px');
    expect(listbox.style.position).toBe('relative');

    const options = getAllByRole('option');
    expect(options.map((o) => o.id)).toEqual(['demo-option-0', 'demo-option-1', 'demo-option-2']);
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(options[1]!.style.transform).toBe('translateY(20px)');
    expect(options[1]!.style.position).toBe('absolute');
  });

  it('无结果:不设 aria-controls / aria-activedescendant,expanded 仍 true(A100/A101)', () => {
    const { getByTestId } = render(<Harness count={0} selectedIndex={0} />);
    const input = getByTestId('input');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.hasAttribute('aria-controls')).toBe(false);
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('选中项越界或不在渲染窗口内:不设 aria-activedescendant(A111/A112)', () => {
    const outOfWindow = render(<Harness count={10} selectedIndex={7} />);
    expect(outOfWindow.getByTestId('input').hasAttribute('aria-activedescendant')).toBe(false);
    outOfWindow.unmount();
    const outOfRange = render(<Harness count={2} selectedIndex={5} />);
    expect(outOfRange.getByTestId('input').hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('键盘:上下键移动、Enter 触发,其余键不拦', () => {
    const moveSelection = vi.fn();
    const onEnter = vi.fn();
    const { getByTestId } = render(
      <Harness count={5} selectedIndex={2} moveSelection={moveSelection} onEnter={onEnter} />,
    );
    const input = getByTestId('input');
    expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(false); // preventDefault
    expect(fireEvent.keyDown(input, { key: 'ArrowUp' })).toBe(false);
    expect(moveSelection.mock.calls).toEqual([
      [1, 5],
      [-1, 5],
    ]);
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(onEnter).toHaveBeenCalledWith(2);
    expect(fireEvent.keyDown(input, { key: 'a' })).toBe(true);
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('count 变化 → clampSelection;selectedIndex 变化 → scrollToIndex(空列表不滚)', () => {
    const clampSelection = vi.fn();
    const { rerender } = render(
      <Harness count={10} selectedIndex={0} clampSelection={clampSelection} />,
    );
    expect(clampSelection).toHaveBeenLastCalledWith(10);
    expect(scrollToIndexSpy).toHaveBeenLastCalledWith(0);

    rerender(<Harness count={10} selectedIndex={4} clampSelection={clampSelection} />);
    expect(scrollToIndexSpy).toHaveBeenLastCalledWith(4);

    rerender(<Harness count={3} selectedIndex={4} clampSelection={clampSelection} />);
    expect(clampSelection).toHaveBeenLastCalledWith(3);

    scrollToIndexSpy.mockClear();
    rerender(<Harness count={0} selectedIndex={0} clampSelection={clampSelection} />);
    expect(clampSelection).toHaveBeenLastCalledWith(0);
    expect(scrollToIndexSpy).not.toHaveBeenCalled();
  });

  it('isVirtualIndexRendered 单趟判断', () => {
    const rows = [{ index: 0 }, { index: 1 }];
    expect(isVirtualIndexRendered(rows, 1)).toBe(true);
    expect(isVirtualIndexRendered(rows, 3)).toBe(false);
  });
});

describe('接线守卫:两个 picker 走共享实现', () => {
  const read = (rel: string): string =>
    readFileSync(join(__dirname, '..', '..', 'plugins', rel), 'utf-8');

  it.each(['command-palette/store.ts', 'quick-open/store.ts'])('%s 用 createPickerSlice', (rel) => {
    const src = read(rel);
    expect(src).toContain('createPickerSlice(set)');
    expect(src).not.toMatch(/moveSelection: \(delta, max\) =>/);
  });

  it.each(['command-palette/CommandPalette.tsx', 'quick-open/QuickOpenModal.tsx'])(
    '%s 用 usePickerList,不直接 useVirtualizer',
    (rel) => {
      const src = read(rel);
      expect(src).toContain('usePickerList({');
      expect(src).not.toContain('useVirtualizer');
      expect(src).not.toContain('aria-activedescendant=');
    },
  );
});
