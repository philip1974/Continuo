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
const VERSION = 2 as const;
const PRIMARY_WINDOW_SEQ = 0; // 主窗位的 windowSeq;Phase 2B 引入多窗后改成动态值

const ALLOWED_SORT_BY = new Set(['name', 'mtime', 'ctime', 'size']);

/**
 * v2 schema(issue #23 Phase 2):全局共享段(workspace.recentRoots / pinned)
 * 移到顶层,workspace.root / explorer / layoutUi / editor 拆到 windows[] 按
 * windowSeq 索引。Phase 2A 主窗仍只读写 windows[0],对外语义无变化;Phase 2B
 * 引入动态 windowSeq 后,每窗口只读写自己段,实现多窗持久化。
 */
export interface ExplorerWindowEntry {
  readonly windowSeq: number;
  readonly workspace: { readonly root: string | null };
  readonly explorer: {
    readonly activePath: string | null;
    readonly expandedPaths: ReadonlyArray<string>;
    readonly sort: ExplorerSort;
  };
  readonly layoutUi?: {
    readonly sidebarOpen: boolean;
    readonly sidebarWidth: number;
  };
  readonly editor?: {
    readonly openFilePaths: ReadonlyArray<string>;
    readonly activePath: string | null;
  };
}

export interface ExplorerSnapshot {
  readonly version: 2;
  readonly workspace: { readonly recentRoots: ReadonlyArray<string> };
  readonly pinned: { readonly paths: ReadonlyArray<string> };
  readonly nextWindowSeq: number;
  readonly windows: ReadonlyArray<ExplorerWindowEntry>;
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
  /**
   * 多窗口 Phase 1(issue #23):新主窗口启动时通过 query string 指定要打开
   * 的 workspace。有值时:
   *   - workspace.root 用此值,而非 explorer.json 的持久化值
   *   - layoutUi / expandedPaths / editor 全部用默认(每窗口独立 UI 状态)
   *   - workspace.recentRoots / pinned 仍读 explorer.json(全局共享)
   *   - **不 subscribe persist** — Phase 1 临时妥协,避免新窗状态覆盖主窗
   *     持久化文件。Phase 2 改 schema 按 windowId 拆段后,新窗也能持久化。
   */
  readonly initialWorkspace?: string;
}

// ──────────────────────────────────────────────
// snapshotFromStores / hydrateStores
// ──────────────────────────────────────────────

/**
 * 取 snap 中归属 windowSeq 的段;无则返 null(主窗的 hydrate 兜底用)。
 * Phase 2A 主窗永远用 PRIMARY_WINDOW_SEQ,Phase 2B 改成动态值。
 */
function findWindowEntry(
  snap: ExplorerSnapshot,
  windowSeq: number,
): ExplorerWindowEntry | null {
  return snap.windows.find((w) => w.windowSeq === windowSeq) ?? null;
}

export function snapshotFromStores(
  /** Phase 2A 默认主窗段;Phase 2B 调用方传当前窗口 windowSeq + 已有段合并写回. */
  prevSnap?: ExplorerSnapshot,
  windowSeq: number = PRIMARY_WINDOW_SEQ,
): ExplorerSnapshot {
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

  const myEntry: ExplorerWindowEntry = {
    windowSeq,
    workspace: { root: w.root },
    explorer: {
      activePath: e.activePath,
      expandedPaths: [...e.expandedPaths],
      sort: { ...e.sort },
    },
    layoutUi: { sidebarOpen: ui.sidebarOpen, sidebarWidth: ui.sidebarWidth },
    editor: { openFilePaths, activePath },
  };

  // 合并到 prevSnap 的其它窗段,自己段覆盖
  const otherWindows =
    prevSnap?.windows.filter((x) => x.windowSeq !== windowSeq) ?? [];
  const nextWindowSeq = Math.max(
    prevSnap?.nextWindowSeq ?? windowSeq + 1,
    windowSeq + 1,
  );

  return {
    version: VERSION,
    workspace: { recentRoots: [...w.recentRoots] },
    pinned: { paths: [...p.paths] },
    nextWindowSeq,
    windows: [...otherWindows, myEntry],
  };
}

export function hydrateStores(
  snap: ExplorerSnapshot,
  windowSeq: number = PRIMARY_WINDOW_SEQ,
): void {
  const entry = findWindowEntry(snap, windowSeq);
  // 全局共享段
  useWorkspaceStore.setState({
    root: entry?.workspace.root ?? null,
    recentRoots: [...snap.workspace.recentRoots],
  });
  usePinnedStore.setState({
    paths: [...snap.pinned.paths],
  });
  // 窗口段(无 entry 时复位默认)
  if (entry) {
    useExplorerStore.setState({
      activePath: entry.explorer.activePath,
      expandedPaths: new Set(entry.explorer.expandedPaths),
      sort: entry.explorer.sort,
      search: '',
    });
    if (entry.layoutUi) {
      useLayoutUiStore.setState({
        sidebarOpen: entry.layoutUi.sidebarOpen,
        sidebarWidth: clampWidth(
          entry.layoutUi.sidebarWidth,
          SIDEBAR_MIN_WIDTH,
          SIDEBAR_MAX_WIDTH,
        ),
      });
    } else {
      useLayoutUiStore.setState({
        sidebarOpen: true,
        sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      });
    }
  } else {
    useExplorerStore.setState({
      activePath: null,
      expandedPaths: new Set(),
      sort: { by: 'name', reverse: false },
      search: '',
    });
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
  windowSeq: number = PRIMARY_WINDOW_SEQ,
): Promise<void> {
  const entry = findWindowEntry(snap, windowSeq);
  if (!entry?.editor || entry.editor.openFilePaths.length === 0) return;
  const paths = entry.editor.openFilePaths;
  const results = await Promise.all(paths.map((p) => fs.readFile(p)));
  const store = useEditorStore.getState();
  for (let i = 0; i < paths.length; i++) {
    const r = results[i];
    if (!r || !r.ok) continue;
    store.openTab(createTab(paths[i]!, r.data));
  }
  // 重读最新 store(openTab 改了状态)
  const next = useEditorStore.getState();
  const desired = entry.editor.activePath;
  if (desired && next.tabs.some((t) => t.id === desired)) {
    next.switchTab(desired);
  }
}

// 防御性 schema 校验(主进程已校验,这里给 init 流程兜底,失败就不 hydrate)
function isExplorerSnapshot(v: unknown): v is ExplorerSnapshot {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o['version'] !== 2) return false;
  if (!o['workspace'] || !o['pinned'] || !Array.isArray(o['windows'])) return false;
  if (typeof o['nextWindowSeq'] !== 'number') return false;
  const ws = o['workspace'] as Record<string, unknown>;
  const pn = o['pinned'] as Record<string, unknown>;
  if (!Array.isArray(ws['recentRoots'])) return false;
  if (!Array.isArray(pn['paths'])) return false;
  for (const wRaw of o['windows'] as unknown[]) {
    if (!wRaw || typeof wRaw !== 'object') return false;
    const w = wRaw as Record<string, unknown>;
    if (typeof w['windowSeq'] !== 'number') return false;
    const wsEntry = w['workspace'] as Record<string, unknown> | undefined;
    if (!wsEntry) return false;
    if (typeof wsEntry['root'] !== 'string' && wsEntry['root'] !== null) return false;
    const ex = w['explorer'] as Record<string, unknown> | undefined;
    if (!ex) return false;
    if (typeof ex['activePath'] !== 'string' && ex['activePath'] !== null) return false;
    if (!Array.isArray(ex['expandedPaths'])) return false;
    const sort = ex['sort'] as Record<string, unknown> | undefined;
    if (!sort || !ALLOWED_SORT_BY.has(sort['by'] as string)) return false;
    if (typeof sort['reverse'] !== 'boolean') return false;
  }
  return true;
}

// ──────────────────────────────────────────────
// initExplorerPersistence
// ──────────────────────────────────────────────

export async function initExplorerPersistence(
  api: ExplorerPersistApi,
  extras?: InitExplorerPersistenceExtras,
): Promise<void> {
  const initialWorkspace = extras?.initialWorkspace;

  // 1. read + sync hydrate(失败不 crash)
  let hydratedSnap: ExplorerSnapshot | null = null;
  try {
    const r = await api.read();
    if (r.ok && r.data && isExplorerSnapshot(r.data)) {
      hydratedSnap = r.data;
      if (initialWorkspace) {
        // 新窗口:只用 explorer.json 的全局段(recentRoots / pinned),
        // 其他用默认 + initialWorkspace。
        hydrateStoresForNewWindow(r.data, initialWorkspace);
      } else {
        hydrateStores(r.data);
      }
    } else if (initialWorkspace) {
      // 没有 explorer.json,但 query 给了 workspace → 从默认起步 + workspace
      hydrateStoresForNewWindow(null, initialWorkspace);
    }
  } catch (err) {
    console.warn('[explorer-persist] read failed', err);
  }

  // 2. async hydrate editor tabs(主窗口才 restore,新窗口空 editor 起步)
  if (!initialWorkspace && hydratedSnap && extras?.fs) {
    try {
      await hydrateEditorTabs(hydratedSnap, extras.fs);
    } catch (err) {
      console.warn('[explorer-persist] hydrate editor failed', err);
    }
  }

  // 3. 订阅 + debounce 写。新窗口不 subscribe(Phase 1 妥协,Phase 2B 按
  //    windowSeq 拆段后再开持久化)。
  if (initialWorkspace) return;

  // 闭包持当前 snap;每次 write 在 prevSnap 基础上合并自己段,保留其它窗段。
  let lastSnap: ExplorerSnapshot | null = hydratedSnap;
  const persist = debounce(async () => {
    try {
      const snap = snapshotFromStores(lastSnap ?? undefined);
      const w = await api.write(snap);
      if (w.ok) {
        lastSnap = snap;
      } else {
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

/**
 * 新窗口 hydrate(Phase 1):全局段(recentRoots / pinned)从 snap 拉,workspace
 * 用 query 指定值,UI 状态(expandedPaths / layoutUi / editor)全用默认。
 * snap 为 null 时(没有 explorer.json),所有字段用默认 + initialWorkspace。
 */
function hydrateStoresForNewWindow(
  snap: ExplorerSnapshot | null,
  initialWorkspace: string,
): void {
  useWorkspaceStore.setState({
    root: initialWorkspace,
    recentRoots: snap ? [...snap.workspace.recentRoots] : [],
  });
  // 主窗段的 sort 拿来当默认(同项目两窗口偏好排序应一致),无则 by:name
  const primary = snap ? findWindowEntry(snap, PRIMARY_WINDOW_SEQ) : null;
  useExplorerStore.setState({
    activePath: null,
    expandedPaths: new Set(),
    sort: primary ? primary.explorer.sort : { by: 'name', reverse: false },
    search: '',
  });
  usePinnedStore.setState({
    paths: snap ? [...snap.pinned.paths] : [],
  });
  useLayoutUiStore.setState({
    sidebarOpen: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  });
}
