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
   * 否则 race(persistence 还没读完 explorer.json)→ root=null → terminal.create 报 TERMINAL_CWD_UNRESOLVED。
   * initExplorerPersistence 完成(成功 / 失败 / 没有持久化文件)都置 true。
   */
  hydrated: boolean;
  /** 切换 root;同时 LRU 维护 recentRoots. null 时只清 root,不动 recent.
   *  副作用:旧 root 外的 file tab 自动关闭(untitled 草稿保留). */
  setRoot: (path: string | null) => void;
  /** 持久化层调用,置 hydrated=true。幂等。 */
  markHydrated: () => void;
};

/**
 * 归一化 workspace root: 仅过滤空字符串 / 全空白 / 非字符串 → null.
 * **不规范化路径语义, 不 trim 返回值** — 文件系统允许前后空格的合法路径 (e.g. '/tmp/proj ').
 * 应用于:
 * - setRoot (用户/UI 触发)
 * - hydrateStores (磁盘 hydrate)
 * - hydrateStoresForNewWindow
 * - snapshotFromStores (持久化前清洗)
 * - recentRoots 过滤
 */
export function normalizeWorkspaceRoot(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  return path.trim().length === 0 ? null : path;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  root: null,
  recentRoots: [],
  hydrated: false,
  markHydrated: () => set({ hydrated: true }),
  setRoot: (path) => {
    const normalized = normalizeWorkspaceRoot(path);
    // 切换/关闭 root 时同步清掉 root 外的 file tab,避免旧路径残留误导
    useEditorStore.getState().closeTabsOutsideRoot(normalized);
    set((s) => {
      if (normalized === null) return { root: null };
      const filtered = s.recentRoots
        .map(normalizeWorkspaceRoot)
        .filter((p): p is string => p !== null && p !== normalized);
      const next = [normalized, ...filtered].slice(0, RECENT_LIMIT);
      return { root: normalized, recentRoots: next };
    });
  },
}));

/**
 * 等待持久化层完成初次 hydrate(幂等:已 hydrated 立即 resolve)。
 * 消费方在读 `root` 决定行为前**必须** await 这个 —— 否则冷启动 race(initExplorerPersistence
 * 还没读完 explorer.json)会读到初始 `root=null`(见上方 `hydrated` 注释 + stores/README)。
 * markHydrated 在 init 成功/失败/无文件都会调,故此 Promise 总会 settle,不会挂死。
 */
export function waitForWorkspaceHydrated(): Promise<void> {
  if (useWorkspaceStore.getState().hydrated) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = useWorkspaceStore.subscribe((s) => {
      if (s.hydrated) {
        unsub();
        resolve();
      }
    });
    // 订阅后再查一次,弥合 getState 与 subscribe 之间的瞬时翻转(否则可能丢 markHydrated 事件)。
    if (useWorkspaceStore.getState().hydrated) {
      unsub();
      resolve();
    }
  });
}
