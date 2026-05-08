// 资源管理器持久化层(M-Explorer Step 3 / ADR-012)。
// 职责:启动时从 IPC 读 explorer.json hydrate 三 store;
// 三 store 任一变化 → debounce 300ms 写回 IPC。
//
// 持久化字段范围(VSCode 风):
//   ✅ workspace.root / recentRoots
//   ✅ explorer.activePath / expandedPaths / sort
//   ✅ pinned.paths
//   ✅ editor.openFilePaths / activePath(M-Editor Step E5,session 恢复)
//   ❌ explorer.selectedPaths / lastAnchorPath / search(瞬时态)
//   ❌ editor.content / dirty(MVP 不做 hot exit,启动从磁盘读最新)
//
// 数据形态:磁盘 JSON 全用 array,store 内部 expandedPaths 用 Set。
// snapshot/hydrate 负责 Set ↔ array 互转。
//
// editor 字段是 async hydrate(需要 fs.readFile),通过 extras.fs 注入。
// BDD: editor-session-restore。

import {
  createTab,
  useEditorStore,
} from '@/stores/editor.store';
import { useExplorerStore, type ExplorerSort } from '@/stores/explorer.store';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useLayoutUiStore,
} from '@/stores/layout-ui.store';
import { usePinnedStore } from '@/stores/pinned.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { debounce } from '@/lib/debounce';
import { clampWidth } from '@/lib/use-column-resize';
import type { IpcResult } from '../fs/types';

const DEBOUNCE_MS = 300;
const VERSION = 1 as const;

const ALLOWED_SORT_BY = new Set(['name', 'mtime', 'ctime', 'size']);

export interface ExplorerSnapshot {
  readonly version: 1;
  readonly workspace: {
    readonly root: string | null;
    readonly recentRoots: ReadonlyArray<string>;
  };
  readonly explorer: {
    readonly activePath: string | null;
    readonly expandedPaths: ReadonlyArray<string>;
    readonly sort: ExplorerSort;
  };
  readonly pinned: {
    readonly paths: ReadonlyArray<string>;
  };
  /** Optional 向下兼容旧 explorer.json. */
  readonly layoutUi?: {
    readonly sidebarOpen: boolean;
    readonly sidebarWidth: number;
  };
  /** Optional. Editor session(M-Editor Step E5)— 只存路径,启动从磁盘读内容. */
  readonly editor?: {
    readonly openFilePaths: ReadonlyArray<string>;
    readonly activePath: string | null;
  };
}

export interface ExplorerPersistApi {
  read: () => Promise<IpcResult<unknown | null>>;
  write: (snap: ExplorerSnapshot) => Promise<IpcResult<void>>;
}

/** Editor session 异步 hydrate 所需的 fs 子集(只用 readFile). */
export interface EditorSessionFsApi {
  readFile: (path: string) => Promise<IpcResult<string>>;
}

export interface InitExplorerPersistenceExtras {
  readonly fs?: EditorSessionFsApi;
}

// ──────────────────────────────────────────────
// snapshotFromStores / hydrateStores
// ──────────────────────────────────────────────

export function snapshotFromStores(): ExplorerSnapshot {
  const w = useWorkspaceStore.getState();
  const e = useExplorerStore.getState();
  const p = usePinnedStore.getState();
  const ui = useLayoutUiStore.getState();
  const ed = useEditorStore.getState();
  // 过滤掉 untitled tab(filePath=null)— 没有路径无法恢复
  const openFilePaths = ed.tabs
    .map((t) => t.filePath)
    .filter((p): p is string => p !== null);
  const activeTab = ed.tabs.find((t) => t.id === ed.activeTabId);
  const activePath = activeTab?.filePath ?? null;
  return {
    version: VERSION,
    workspace: {
      root: w.root,
      recentRoots: [...w.recentRoots],
    },
    explorer: {
      activePath: e.activePath,
      expandedPaths: [...e.expandedPaths],
      sort: { ...e.sort },
    },
    pinned: {
      paths: [...p.paths],
    },
    layoutUi: {
      sidebarOpen: ui.sidebarOpen,
      sidebarWidth: ui.sidebarWidth,
    },
    editor: {
      openFilePaths,
      activePath,
    },
  };
}

export function hydrateStores(snap: ExplorerSnapshot): void {
  useWorkspaceStore.setState({
    root: snap.workspace.root,
    recentRoots: [...snap.workspace.recentRoots],
  });
  useExplorerStore.setState({
    activePath: snap.explorer.activePath,
    expandedPaths: new Set(snap.explorer.expandedPaths),
    sort: snap.explorer.sort,
    // 瞬时态显式复位:防止 hydrate 后残留上一次会话的 search
    search: '',
  });
  usePinnedStore.setState({
    paths: [...snap.pinned.paths],
  });
  // layoutUi 可选(向下兼容旧 explorer.json):缺失时保留 store 默认值。
  // 宽度防御性 clamp(防磁盘脏数据导致 sidebar 撑爆 / 消失)
  if (snap.layoutUi) {
    useLayoutUiStore.setState({
      sidebarOpen: snap.layoutUi.sidebarOpen,
      sidebarWidth: clampWidth(
        snap.layoutUi.sidebarWidth,
        SIDEBAR_MIN_WIDTH,
        SIDEBAR_MAX_WIDTH,
      ),
    });
  } else {
    // 显式复位到 default(防 hydrate 重复触发时残留)
    useLayoutUiStore.setState({
      sidebarOpen: true,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    });
  }
}

/**
 * Editor session 异步 hydrate:并发 readFile,只为 ok 结果 openTab,顺序保留。
 * 不抛 — 单文件失败(被删 / 移动)静默跳过。
 */
export async function hydrateEditorTabs(
  snap: ExplorerSnapshot,
  fs: EditorSessionFsApi,
): Promise<void> {
  if (!snap.editor || snap.editor.openFilePaths.length === 0) return;
  const paths = snap.editor.openFilePaths;
  const results = await Promise.all(paths.map((p) => fs.readFile(p)));
  const store = useEditorStore.getState();
  for (let i = 0; i < paths.length; i++) {
    const r = results[i];
    if (!r || !r.ok) continue;
    store.openTab(createTab(paths[i]!, r.data));
  }
  // 重读最新 store(openTab 改了状态)
  const next = useEditorStore.getState();
  const desired = snap.editor.activePath;
  if (desired && next.tabs.some((t) => t.id === desired)) {
    next.switchTab(desired);
  }
}

// 防御性 schema 校验(主进程已校验,这里给 init 流程兜底,失败就不 hydrate)
function isExplorerSnapshot(v: unknown): v is ExplorerSnapshot {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o['version'] !== 1) return false;
  if (!o['workspace'] || !o['explorer'] || !o['pinned']) return false;
  const ws = o['workspace'] as Record<string, unknown>;
  const ex = o['explorer'] as Record<string, unknown>;
  const pn = o['pinned'] as Record<string, unknown>;
  if (typeof ws['root'] !== 'string' && ws['root'] !== null) return false;
  if (!Array.isArray(ws['recentRoots'])) return false;
  if (typeof ex['activePath'] !== 'string' && ex['activePath'] !== null) return false;
  if (!Array.isArray(ex['expandedPaths'])) return false;
  const sort = ex['sort'] as Record<string, unknown> | undefined;
  if (!sort || !ALLOWED_SORT_BY.has(sort['by'] as string)) return false;
  if (typeof sort['reverse'] !== 'boolean') return false;
  if (!Array.isArray(pn['paths'])) return false;
  return true;
}

// ──────────────────────────────────────────────
// initExplorerPersistence
// ──────────────────────────────────────────────

export async function initExplorerPersistence(
  api: ExplorerPersistApi,
  extras?: InitExplorerPersistenceExtras,
): Promise<void> {
  // 1. read + sync hydrate(失败不 crash)
  let hydratedSnap: ExplorerSnapshot | null = null;
  try {
    const r = await api.read();
    if (r.ok && r.data && isExplorerSnapshot(r.data)) {
      hydratedSnap = r.data;
      hydrateStores(r.data);
    }
  } catch (err) {
    console.warn('[explorer-persist] read failed', err);
  }

  // 2. async hydrate editor tabs(在 attach subscribe 之前完成,
  //    避免 hydrate 期间 openTab 触发 debounced write 回环)
  if (hydratedSnap && extras?.fs) {
    try {
      await hydrateEditorTabs(hydratedSnap, extras.fs);
    } catch (err) {
      console.warn('[explorer-persist] hydrate editor failed', err);
    }
  }

  // 3. 订阅 + debounce 写
  const persist = debounce(async () => {
    try {
      const snap = snapshotFromStores();
      const w = await api.write(snap);
      if (!w.ok) {
        console.warn('[explorer-persist] write failed', w.code, w.message);
      }
    } catch (err) {
      console.warn('[explorer-persist] write threw', err);
    }
  }, DEBOUNCE_MS);

  useWorkspaceStore.subscribe(persist);
  useExplorerStore.subscribe(persist);
  usePinnedStore.subscribe(persist);
  useLayoutUiStore.subscribe(persist);
  useEditorStore.subscribe(persist);
}
