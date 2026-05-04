import { create } from 'zustand';

const RECENT_LIMIT = 5;

type WorkspaceState = {
  /** 当前 workspace 根目录绝对路径,null 表示未选(EmptyWorkspace 占位). */
  root: string | null;
  /** LRU,最近在前,最多 5 个. */
  recentRoots: readonly string[];
  /** 切换 root;同时 LRU 维护 recentRoots. null 时只清 root,不动 recent. */
  setRoot: (path: string | null) => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  root: null,
  recentRoots: [],
  setRoot: (path) =>
    set((s) => {
      if (path === null) return { root: null };
      const filtered = s.recentRoots.filter((p) => p !== path);
      const next = [path, ...filtered].slice(0, RECENT_LIMIT);
      return { root: path, recentRoots: next };
    }),
}));
