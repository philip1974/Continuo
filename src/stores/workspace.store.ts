import { create } from 'zustand';
import { useEditorStore } from './editor.store';

const RECENT_LIMIT = 5;

type WorkspaceState = {
  /** 当前 workspace 根目录绝对路径,null 表示未选(EmptyWorkspace 占位). */
  root: string | null;
  /** LRU,最近在前,最多 5 个. */
  recentRoots: readonly string[];
  /**
   * 持久化层是否已完成初次 hydrate。
   * 消费方(如 TerminalPanel)读 workspaceRoot 决定新 PTY cwd 时需要等这个标志,
   * 否则 race(persistence 还没读完 explorer.json)→ root=null → cwd 兜底到 homedir。
   * initExplorerPersistence 完成(成功 / 失败 / 没有持久化文件)都置 true。
   */
  hydrated: boolean;
  /** 切换 root;同时 LRU 维护 recentRoots. null 时只清 root,不动 recent.
   *  副作用:旧 root 外的 file tab 自动关闭(untitled 草稿保留). */
  setRoot: (path: string | null) => void;
  /** 持久化层调用,置 hydrated=true。幂等。 */
  markHydrated: () => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  root: null,
  recentRoots: [],
  hydrated: false,
  markHydrated: () => set({ hydrated: true }),
  setRoot: (path) => {
    // 切换/关闭 root 时同步清掉 root 外的 file tab,避免旧路径残留误导
    useEditorStore.getState().closeTabsOutsideRoot(path);
    set((s) => {
      if (path === null) return { root: null };
      const filtered = s.recentRoots.filter((p) => p !== path);
      const next = [path, ...filtered].slice(0, RECENT_LIMIT);
      return { root: path, recentRoots: next };
    });
  },
}));
