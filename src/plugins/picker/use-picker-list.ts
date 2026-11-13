// 「搜索框(combobox)+ 虚拟化 listbox」的共享列表机制(重构:CommandPalette 与 QuickOpenModal
// 此前逐段复制 virtualizer 接线 / 越界钳制 / 滚动跟随 / 键盘导航 / combobox·listbox·option 的
// ARIA 属性;a11y A15/A100/A101/A111/A112 与 race R48/R49 每次都要两边同步)。
//
// 模式:焦点始终留在输入框,上下键移动 listbox 的「虚拟选中」,Enter 触发当前项。
// 两个组件只保留:数据源 / 过滤、行内容、空态分支、Enter 的业务动作。
//
// BDD: src/__tests__/picker-shared/

import { useEffect, useRef } from 'react';
import type React from 'react';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';

/** 单趟判断 index 是否在 virtualizer 当前渲染窗口内。 */
export function isVirtualIndexRendered(
  virtualItems: readonly { readonly index: number }[],
  selectedIndex: number,
): boolean {
  for (const item of virtualItems) {
    if (item.index === selectedIndex) return true;
  }
  return false;
}

export interface UsePickerListOptions {
  /** DOM id 前缀:listbox = `${idPrefix}-listbox`,option = `${idPrefix}-option-${index}`。 */
  readonly idPrefix: string;
  /** 过滤后的逻辑全集长度(只渲染可视窗口)。 */
  readonly count: number;
  readonly selectedIndex: number;
  readonly rowHeight: number;
  readonly overscan: number;
  readonly moveSelection: (delta: number, max: number) => void;
  readonly clampSelection: (len: number) => void;
  /** Enter:调用方按 index 取项并执行(index 可能越界,自行判空)。 */
  readonly onEnter: (index: number) => void;
}

export interface PickerComboboxProps {
  readonly role: 'combobox';
  readonly 'aria-expanded': true;
  readonly 'aria-controls': string | undefined;
  readonly 'aria-activedescendant': string | undefined;
  readonly onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export interface PickerListboxProps {
  readonly id: string;
  readonly role: 'listbox';
  readonly style: React.CSSProperties;
}

export interface PickerOptionProps {
  readonly id: string;
  readonly role: 'option';
  readonly 'aria-selected': boolean;
  readonly style: React.CSSProperties;
}

export interface PickerList {
  /** 挂到滚动容器。 */
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
  readonly virtualItems: readonly VirtualItem[];
  /** 展开到搜索 <Input>。 */
  readonly comboboxProps: PickerComboboxProps;
  /** 展开到 <ul>(仅在有结果时渲染它)。 */
  readonly listboxProps: PickerListboxProps;
  /** 展开到每个可视行 <li>。 */
  readonly getOptionProps: (row: VirtualItem) => PickerOptionProps;
}

export function usePickerList(opts: UsePickerListOptions): PickerList {
  const { idPrefix, count, selectedIndex, moveSelection, clampSelection, onEnter } = opts;
  const { rowHeight } = opts;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: opts.overscan,
  });

  // race(R48/R49):列表动态变短时把 selectedIndex 钳回 [0,len-1],防 Enter 读越界项 + 高亮/滚动
  // 悬空。须在下方 scroll effect 之前生效(声明在前 → 同次提交里先钳后滚)。
  useEffect(() => {
    clampSelection(count);
  }, [count, clampSelection]);

  // 键盘改 selectedIndex → 滚到可视区(虚拟化后选中行可能未挂载)。
  useEffect(() => {
    if (count === 0) return;
    rowVirtualizer.scrollToIndex(selectedIndex);
  }, [selectedIndex, count, rowVirtualizer]);

  // a11y(A112,A111 后续):aria-activedescendant 只能指向 DOM 中真实挂载的 option。虚拟列表里
  // 选中项可能逻辑有效但不在渲染窗口内(scrollToIndex 滚入前的瞬态)→ 须校验其在渲染窗口内。
  const virtualItems = rowVirtualizer.getVirtualItems();
  const activeOptionRendered = isVirtualIndexRendered(virtualItems, selectedIndex);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1, count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1, count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onEnter(selectedIndex);
    }
  };

  return {
    scrollRef,
    virtualItems,
    comboboxProps: {
      // a11y(A15):combobox 模式须 role=combobox + aria-controls 指向 listbox +
      // aria-activedescendant 指向当前高亮 option,否则 SR 按上下键不知高亮哪条。
      role: 'combobox',
      // a11y(A100):弹层打开即可见(无结果也显示空态)→ aria-expanded 恒 true;按结果数设 false
      // 会与可见状态矛盾。无结果只移除 aria-activedescendant。
      'aria-expanded': true,
      // a11y(A101):listbox 只在有结果时渲染 → 仅有结果时设 aria-controls,否则引用悬空。
      'aria-controls': count > 0 ? `${idPrefix}-listbox` : undefined,
      // a11y(A111):校验 selectedIndex 不越界,避免结果变短时指向不存在的 option id。
      'aria-activedescendant':
        selectedIndex >= 0 && selectedIndex < count && activeOptionRendered
          ? `${idPrefix}-option-${selectedIndex}`
          : undefined,
      onKeyDown,
    },
    listboxProps: {
      id: `${idPrefix}-listbox`,
      role: 'listbox',
      style: { height: rowVirtualizer.getTotalSize(), position: 'relative' },
    },
    getOptionProps: (row) => ({
      id: `${idPrefix}-option-${row.index}`,
      role: 'option',
      'aria-selected': row.index === selectedIndex,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: row.size,
        transform: `translateY(${row.start}px)`,
      },
    }),
  };
}
