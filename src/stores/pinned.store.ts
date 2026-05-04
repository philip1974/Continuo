import { create } from 'zustand';

type PinnedState = {
  /** 顺序保留(Pin 在文件列表置顶时按此顺序). */
  paths: readonly string[];
  /** 已 pin → 移除;未 pin → 追加到末尾. */
  toggle: (path: string) => void;
  clear: () => void;
};

export const usePinnedStore = create<PinnedState>((set) => ({
  paths: [],
  toggle: (path) =>
    set((s) => {
      if (s.paths.includes(path)) {
        return { paths: s.paths.filter((p) => p !== path) };
      }
      return { paths: [...s.paths, path] };
    }),
  clear: () => set(() => ({ paths: [] })),
}));
