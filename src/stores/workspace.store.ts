import { create } from 'zustand';
import { useEditorStore } from './editor.store';
import { PATH_STR_MAX } from '../../electron/shared/explorer-persistence-schema';

const RECENT_LIMIT = 5;

export function buildRecentRoots(
  recentRoots: readonly string[],
  normalized: string,
): string[] {
  if (recentRoots[0] === normalized && recentRoots.length <= RECENT_LIMIT) {
    let canReuse = true;
    for (let i = 0; i < recentRoots.length; i++) {
      const p = normalizeWorkspaceRoot(recentRoots[i]);
      if (p === null || p !== recentRoots[i]) {
        canReuse = false;
        break;
      }
      for (let j = 0; j < i; j++) {
        if (recentRoots[j] === p) {
          canReuse = false;
          break;
        }
      }
      if (!canReuse) break;
    }
    if (canReuse) return recentRoots as string[];
  }

  const next = new Array<string>(Math.min(RECENT_LIMIT, recentRoots.length + 1));
  let count = 0;
  next[count++] = normalized;
  for (const raw of recentRoots) {
    if (count >= RECENT_LIMIT) break;
    const p = normalizeWorkspaceRoot(raw);
    if (p !== null && p !== normalized) next[count++] = p;
  }
  next.length = count;
  return next;
}

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
 * 归一化 workspace root: 过滤空字符串 / 全空白 / 非字符串 / 超 PATH_STR_MAX → null.
 * **不规范化路径语义, 不 trim 返回值** — 文件系统允许前后空格的合法路径 (e.g. '/tmp/proj ').
 * 应用于:
 * - setRoot (用户/UI 触发)
 * - hydrateStores (磁盘 hydrate)
 * - hydrateStoresForNewWindow
 * - snapshotFromStores (持久化前清洗)
 * - recentRoots 过滤
 *
 * 边界(E317,E276/E277/E278 同族:运行时把状态约束在持久化契约内):root/recentRoots 经
 * snapshotFromStores 写入 ExplorerWritableSnapshotSchema —— root=pathStr().nullable()、
 * recentRoots=array(pathStr()),pathStr() 即 z.string().max(PATH_STR_MAX)。运行时若持有超
 * PATH_STR_MAX 的 root/recentRoot,snapshot 写出后整份 schema 拒 → explorer 持久化全失败(连带
 * recentRoots/pinned/各窗口/layout/editor 会话一起丢)。故在唯一 chokepoint 加同一上限:超限 → null
 *(root 视作未选,recentRoot 被过滤),与 explorer/editor/pinned store 的运行时 cap 一致。真实路径远
 * 短于 8192,行为保持;仅挡畸形/恶意超长路径(拖拽深嵌目录 / 插件经 open-folder 入口传超长串)。
 */
export function normalizeWorkspaceRoot(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  if (path.length > PATH_STR_MAX) return null;
  return path.trim().length === 0 ? null : path;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  root: null,
  recentRoots: [],
  hydrated: false,
  markHydrated: () => set((s) => (s.hydrated ? s : { hydrated: true })),
  setRoot: (path) => {
    const normalized = normalizeWorkspaceRoot(path);
    // 切换/关闭 root 时同步清掉 root 外的 file tab,避免旧路径残留误导
    useEditorStore.getState().closeTabsOutsideRoot(normalized);
    set((s) => {
      if (normalized === null) return s.root === null ? s : { root: null };
      const recentRoots = buildRecentRoots(s.recentRoots, normalized);
      if (s.root === normalized && recentRoots === s.recentRoots) return s;
      return {
        root: normalized,
        recentRoots,
      };
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
