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

export function buildToggledPinnedPaths(
  paths: readonly string[],
  path: string,
): readonly string[] {
  const idx = paths.indexOf(path);
  if (idx >= 0) {
    const next = new Array<string>(paths.length - 1);
    let count = 0;
    for (let i = 0; i < paths.length; i++) {
      if (i !== idx) next[count++] = paths[i]!;
    }
    return next;
  }
  // 边界(E276,运行时状态须守持久化契约):pin 追加不得超持久化 schema 上限 —— 超 PINNED_MAX 条或单条
  // path 超 PATH_STR_MAX 则拒加(no-op)。否则 snapshotFromStores 原样写出 → explorer:write 被
  // ExplorerWritableSnapshotSchema 拒整份 → workspace/editor/layout 等所有 explorer 持久化持续失败。
  if (paths.length >= PINNED_MAX || path.length > PATH_STR_MAX) {
    return paths;
  }
  const next = new Array<string>(paths.length + 1);
  for (let i = 0; i < paths.length; i++) next[i] = paths[i]!;
  next[paths.length] = path;
  return next;
}

export const usePinnedStore = create<PinnedState>((set) => ({
  paths: [],
  toggle: (path) =>
    set((s) => {
      const paths = buildToggledPinnedPaths(s.paths, path);
      return paths === s.paths ? s : { paths };
    }),
  clear: () => set(() => ({ paths: [] })),
}));
