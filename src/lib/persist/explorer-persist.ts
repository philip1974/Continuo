// 资源管理器持久化层(M-Explorer Step 3 / ADR-012)。
// 职责:启动时从 IPC 读 explorer.json hydrate 三 store;
// 三 store 任一变化 → debounce 300ms 写回 IPC。
//
// 持久化字段范围(VSCode 风):
//   ✅ workspace.root / recentRoots
//   ✅ explorer.expandedPaths / sort
//   ✅ pinned.paths
//   ✅ editor.openFilePaths / activePath(M-Editor Step E5,session 恢复)
//   ⚠ explorer.activePath:磁盘 schema 保留位(恒 null),runtime store 已无此
//     字段(打磨 R18);snapshot 写 null、hydrate 忽略,仅为兼容旧数据不丢档。
//   ❌ explorer.selectedPaths / lastAnchorPath(多选已由 headless-tree 持有)
//   ❌ explorer.search:已从 runtime store 移除(打磨 R19,无生产 UI 接入)
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
import {
  normalizeWorkspaceRoot,
  useWorkspaceStore,
} from '@/stores/workspace.store';
import { debounce } from '@/lib/debounce';
import { subscribeAll } from '@/plugins/registries/useRegistry';
import { clampWidth } from '@/lib/use-column-resize';
import type { IpcResult } from '../fs/types';

const DEBOUNCE_MS = 300;
const VERSION = 3 as const;
const PRIMARY_WINDOW_SEQ = 0; // 主窗位的 windowSeq;Phase 2B 引入多窗后改成动态值

const ALLOWED_SORT_BY = new Set(['name', 'mtime', 'ctime', 'size']);

/**
 * v3 schema(topic-08):全局共享段(workspace.recentRoots / pinned)
 * 移到顶层,workspace.root / explorer / layoutUi / editor 拆到 windows[] 按
 * windowSeq 索引。renderer 只读写 writable subset;layout / lastClosedAt 是
 * main-owned 字段,hydrate 可容忍但 snapshotFromStores 不写。
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
  readonly layout?: unknown;
  readonly lastClosedAt?: number | null;
}

export interface ExplorerSnapshot {
  readonly version: 2 | 3;
  readonly workspace: { readonly recentRoots: ReadonlyArray<string> };
  readonly pinned: { readonly paths: ReadonlyArray<string> };
  readonly nextWindowSeq: number;
  readonly windows: ReadonlyArray<ExplorerWindowEntry>;
  readonly restoreAllWindowsOnLaunch?: boolean;
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
   * 多窗口 Phase 2B(issue #23):自己窗口的 windowSeq,hydrate / persist 都按
   * 此 seq 读写 windows[] 中自己段。缺省 0(主窗位)。
   */
  readonly windowSeq?: number;
  /**
   * 新主窗口启动时通过 query string 指定的 workspace。Issue #45:
   * `fresh: true` ⇒ 始终覆盖该段;`fresh: false / undefined` ⇒ 仅当段缺失
   * / snap 读失败时作 fallback,有段则忽略 query。
   */
  readonly initialWorkspace?: string;
  /**
   * Issue #45:`true` ⇒ 该窗口是 dock 模式 / CLI argv / 用户显式新开窗口,
   * `windows[<seq>]` 段的旧 workspace.root + UI + editor 全部丢弃,以
   * `initialWorkspace` 作 root。`false` / 未设 ⇒ 走 myEntry 恢复路径;
   * 仅当段缺失或 snap 读失败时,`initialWorkspace` 才作 fallback。
   */
  readonly fresh?: boolean;
}

// ──────────────────────────────────────────────
// snapshotFromStores / hydrateStores
// ──────────────────────────────────────────────

/**
 * 取 snap 中归属 windowSeq 的段;无则返 null(主窗 hydrate 用 null 起步)。
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
  const root = normalizeWorkspaceRoot(w.root);
  const recentRoots = w.recentRoots
    .map(normalizeWorkspaceRoot)
    .filter((p): p is string => p !== null);

  const myEntry: ExplorerWindowEntry = {
    windowSeq,
    workspace: { root },
    explorer: {
      // activePath 已不在 runtime store(打磨 R18:无生产 setter/reader)。磁盘
      // schema 维持兼容,继续写保留位 null;旧数据里的值在 hydrate 时被忽略。
      activePath: null,
      expandedPaths: [...e.expandedPaths],
      sort: { ...e.sort },
    },
    layoutUi: { sidebarOpen: ui.sidebarOpen, sidebarWidth: ui.sidebarWidth },
    editor: { openFilePaths, activePath },
  };

  // 只写自己这一段。**不**把 prevSnap 里其它窗口的段一并写回 —— prevSnap
  // (=lastSnap)是本窗启动时读盘的快照、之后从不刷新,携带的其它窗口段是陈旧的。
  // main 的 explorer:write handler 在 file-mutex 内每次重读磁盘 current,
  // mergeWritableIntoFull 对 writable 没有的 windowSeq 保留磁盘上的最新段
  // (else merged.push(cur))。若这里携带陈旧 otherWindows,反而会把别的窗口
  // 已写盘的最新 root/tabs/expanded 回退成本窗启动时的旧值(跨窗状态丢失)。
  const nextWindowSeq = Math.max(
    prevSnap?.nextWindowSeq ?? windowSeq + 1,
    windowSeq + 1,
  );

  return {
    version: VERSION,
    workspace: { recentRoots },
    pinned: { paths: [...p.paths] },
    nextWindowSeq,
    windows: [myEntry],
  };
}

export function hydrateStores(
  snap: ExplorerSnapshot,
  windowSeq: number = PRIMARY_WINDOW_SEQ,
): void {
  const entry = findWindowEntry(snap, windowSeq);
  // 全局共享段
  useWorkspaceStore.setState({
    root: normalizeWorkspaceRoot(entry?.workspace.root ?? null),
    recentRoots: snap.workspace.recentRoots
      .map(normalizeWorkspaceRoot)
      .filter((p): p is string => p !== null),
  });
  usePinnedStore.setState({
    paths: [...snap.pinned.paths],
  });
  // 窗口段(无 entry 时复位默认)
  if (entry) {
    // entry.explorer.activePath 故意不再回写 store(打磨 R18:store 已无该字段)。
    useExplorerStore.setState({
      expandedPaths: new Set(entry.explorer.expandedPaths),
      sort: entry.explorer.sort,
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
      expandedPaths: new Set(),
      sort: { by: 'name', reverse: false },
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
  // 本轮 restore 期望的 workspace root(= hydrateStores 刚据此 snapshot 段设的 root)。
  // readFile 是异步的,期间用户可能切到别的 workspace(setRoot 会关掉 root 外 tab,但此刻
  // 旧 tab 还没 restore 出来)。若读完后当前 root 已不是期望 root,把旧项目 tab 插进新
  // workspace 是陈旧状态(还会写出 root=新 / openFilePaths=旧 的混合持久化)→ 整轮丢弃。
  // (codex 复审 loop R13;与 R10 终端 hydrate 竞态同类的迟到-restore-vs-切换 race。)
  const expectedRoot = normalizeWorkspaceRoot(entry.workspace.root);
  const paths = entry.editor.openFilePaths;
  const results = await Promise.all(paths.map((p) => fs.readFile(p)));
  if (useWorkspaceStore.getState().root !== expectedRoot) return;
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
  if (o['version'] !== 2 && o['version'] !== 3) return false;
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

// 当前窗口的"立即落盘"句柄(绕过 debounce),由 initExplorerPersistence 注册。
// 每个 renderer 是独立 JS context,各窗只持有/flush 自己的段。
let activeFlush: (() => Promise<void>) | null = null;

/**
 * 立即把 explorer / editor 段落盘,绕过 300ms debounce。供关窗 / 退出的
 * flush-request 调用 —— 否则关窗前 debounce 窗口内的 workspace 切换、tab
 * 打开/关闭、树展开会随未触发的 timer 一起丢失。未初始化时 no-op。
 */
export async function flushExplorerPersistence(): Promise<void> {
  await activeFlush?.();
}

export async function initExplorerPersistence(
  api: ExplorerPersistApi,
  extras?: InitExplorerPersistenceExtras,
): Promise<void> {
  const windowSeq = extras?.windowSeq ?? PRIMARY_WINDOW_SEQ;
  const initialWorkspace = extras?.initialWorkspace;
  const fresh = extras?.fresh === true;

  // 1. read + sync hydrate(失败不 crash)
  let hydratedSnap: ExplorerSnapshot | null = null;
  try {
    const r = await api.read();
    if (r.ok && r.data && isExplorerSnapshot(r.data)) {
      hydratedSnap = r.data;
      const myEntry = findWindowEntry(r.data, windowSeq);
      if (fresh && initialWorkspace !== undefined) {
        // Issue #45:dock 模式 / CLI argv / 用户拖文件夹打开新窗口 ⇒ 强制覆盖该段
        hydrateStoresForNewWindow(r.data, initialWorkspace);
      } else if (myEntry) {
        // 重启恢复(restore-loop / 老窗段已存在)⇒ 按段恢复(含 workspace.root、UI、editor)
        hydrateStores(r.data, windowSeq);
      } else if (initialWorkspace !== undefined) {
        // 段缺失但 query 有 workspace(首次启动 / corrupted snap)⇒ 用 query 作 root
        hydrateStoresForNewWindow(r.data, initialWorkspace);
      } else {
        // 新窗(本来不该走到 — main.tsx 不会缺 windowSeq + 缺 query)→ 默认
        hydrateStores(r.data, windowSeq);
      }
    } else if (initialWorkspace !== undefined) {
      hydrateStoresForNewWindow(null, initialWorkspace);
    }
  } catch (err) {
    console.warn('[explorer-persist] read failed', err);
  }

  // 2. async hydrate editor tabs(只在自己段存在且非 fresh 时 restore)
  if (!fresh && hydratedSnap && extras?.fs && findWindowEntry(hydratedSnap, windowSeq)) {
    try {
      await hydrateEditorTabs(hydratedSnap, extras.fs, windowSeq);
    } catch (err) {
      console.warn('[explorer-persist] hydrate editor failed', err);
    }
  }

  // 同步 workspace 已 hydrate 标志 — TerminalPanel 等消费方需要这个信号才
  // 敢拿 workspaceRoot 决策新 PTY cwd,否则 race 到 root=null → terminal.create 报错
  // (TERMINAL_CWD_UNRESOLVED)。
  // 不论 read 是否成功(包含没有 explorer.json 的首次启动)都置 true。
  useWorkspaceStore.getState().markHydrated();

  // 3. 订阅 + debounce 写。所有窗口都订阅,各写各段(prevSnap 合并保留其它段)。
  let lastSnap: ExplorerSnapshot | null = hydratedSnap;
  const writeNow = async (): Promise<void> => {
    try {
      const snap = snapshotFromStores(lastSnap ?? undefined, windowSeq);
      const w = await api.write(snap);
      if (w.ok) {
        lastSnap = snap;
      } else {
        console.warn('[explorer-persist] write failed', w.code, w.message);
      }
    } catch (err) {
      console.warn('[explorer-persist] write threw', err);
    }
  };
  const persist = debounce(() => {
    void writeNow();
  }, DEBOUNCE_MS);
  // 注册立即落盘句柄,供 flushExplorerPersistence()(关窗 / 退出)调用。
  activeFlush = writeNow;

  subscribeAll(
    [
      useWorkspaceStore,
      useExplorerStore,
      usePinnedStore,
      useLayoutUiStore,
      useEditorStore,
    ],
    persist,
  );
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
    root: normalizeWorkspaceRoot(initialWorkspace),
    recentRoots: snap
      ? snap.workspace.recentRoots
          .map(normalizeWorkspaceRoot)
          .filter((p): p is string => p !== null)
      : [],
  });
  // 主窗段的 sort 拿来当默认(同项目两窗口偏好排序应一致),无则 by:name
  const primary = snap ? findWindowEntry(snap, PRIMARY_WINDOW_SEQ) : null;
  useExplorerStore.setState({
    expandedPaths: new Set(),
    sort: primary ? primary.explorer.sort : { by: 'name', reverse: false },
  });
  usePinnedStore.setState({
    paths: snap ? [...snap.pinned.paths] : [],
  });
  useLayoutUiStore.setState({
    sidebarOpen: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  });
}
