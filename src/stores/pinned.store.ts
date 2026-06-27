import { create } from 'zustand';
import {
  PINNED_MAX,
  PATH_STR_MAX,
} from '../../electron/shared/explorer-persistence-schema';

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
      // 边界(E276,运行时状态须守持久化契约):pin 追加不得超持久化 schema 上限 —— 超 PINNED_MAX 条或单条
      // path 超 PATH_STR_MAX 则拒加(no-op)。否则 snapshotFromStores 原样写出 → explorer:write 被
      // ExplorerWritableSnapshotSchema 拒整份 → workspace/editor/layout 等所有 explorer 持久化持续失败。
      if (s.paths.length >= PINNED_MAX || path.length > PATH_STR_MAX) {
        return s;
      }
      return { paths: [...s.paths, path] };
    }),
  clear: () => set(() => ({ paths: [] })),
}));
