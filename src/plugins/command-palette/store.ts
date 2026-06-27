// 命令面板状态(M-Plugin v1.6)。Zustand vanilla,沿用 ADR-007。

import { create } from 'zustand';
import { clampSearchQuery } from '@/lib/search-query';

interface CommandPaletteState {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  /** 循环移动选中行(到底跳头,到头跳尾);max=0 时不动. */
  moveSelection: (delta: number, max: number) => void;
  /**
   * race(R49,R48 孪生):把 selectedIndex 钳到 [0, len-1](空列表置 0)。filtered 随 commands
   * registry 变化 / 插件 reload·disable / locale·hotkey·recent 重算而动态变短时,旧 selectedIndex
   * 可能越界 → Enter 读 filtered[idx]=undefined 命令无法执行、高亮悬空。组件在 filtered.length
   * 变化时调用。已在范围内则返回原 state,不触发 selectedIndex 订阅者重渲染。
   */
  clampSelection: (len: number) => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  isOpen: false,
  query: '',
  selectedIndex: 0,

  open: () =>
    set((s) =>
      s.isOpen && s.query === '' && s.selectedIndex === 0
        ? s
        : { isOpen: true, query: '', selectedIndex: 0 },
    ),
  close: () => set((s) => (s.isOpen ? { isOpen: false } : s)),
  // 边界(E279):截断超长 query(防单次 paste 触发 O(commands×queryLen) fuzzy 卡死 renderer)。
  setQuery: (q) =>
    set((s) => {
      const query = clampSearchQuery(q);
      return s.query === query && s.selectedIndex === 0
        ? s
        : { query, selectedIndex: 0 };
    }),
  moveSelection: (delta, max) =>
    set((s) => {
      if (max <= 0) return s.selectedIndex === 0 ? s : { selectedIndex: 0 };
      const next = (s.selectedIndex + delta + max) % max;
      return next === s.selectedIndex ? s : { selectedIndex: next };
    }),
  clampSelection: (len) =>
    set((s) => {
      const clamped = len <= 0 ? 0 : Math.min(s.selectedIndex, len - 1);
      return clamped === s.selectedIndex ? s : { selectedIndex: clamped };
    }),
}));
