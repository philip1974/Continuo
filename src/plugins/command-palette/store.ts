// 命令面板状态(M-Plugin v1.6)。Zustand vanilla,沿用 ADR-007。

import { create } from 'zustand';

interface CommandPaletteState {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  /** 循环移动选中行(到底跳头,到头跳尾);max=0 时不动. */
  moveSelection: (delta: number, max: number) => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  isOpen: false,
  query: '',
  selectedIndex: 0,

  open: () => set({ isOpen: true, query: '', selectedIndex: 0 }),
  close: () => set({ isOpen: false }),
  setQuery: (q) => set({ query: q, selectedIndex: 0 }),
  moveSelection: (delta, max) =>
    set((s) => {
      if (max <= 0) return { selectedIndex: 0 };
      const next = (s.selectedIndex + delta + max) % max;
      return { selectedIndex: next };
    }),
}));
