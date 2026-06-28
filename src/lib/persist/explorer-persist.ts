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
  type EditorTab,
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
import { allSettledWithConcurrency } from '@/lib/map-with-concurrency';
import { workspaceRootSelectionGuard } from '@/lib/workspace-root-guard';
import { subscribeAll } from '@/plugins/registries/useRegistry';
import { clampWidth } from '@/lib/use-column-resize';
import { pathEquals } from '@/lib/path-cross';
import { findWindowEntryBySeq } from '../../../electron/shared/window-entry-lookup';
import type { IpcResult } from '../fs/types';
import {
  ExplorerSchema,
  ExplorerSchemaV3,
} from '../../../electron/shared/explorer-persistence-schema';

const DEBOUNCE_MS = 300;
const VERSION = 3 as const;
const PRIMARY_WINDOW_SEQ = 0; // 主窗位的 windowSeq;Phase 2B 引入多窗后改成动态值
// 边界(E216):editor 会话恢复的 tab 数硬上限 + 读取并发上限。explorer.json schema 允许至多 100k
// openFilePaths,畸形/旧快照在启动时 paths.map(readFile)+allSettled 会一次性发起海量并发 IPC/文件读
// promise(单文件大小 cap 不防并发 fan-out)→ renderer/main 卡顿/资源耗尽。截断到 MAX_RESTORED_TABS
//(真实用户 tab 数远低于此)+ 分块并发读(峰值并发钳到 RESTORE_READ_CONCURRENCY,仿 list-dir LSTAT_CHUNK)。
const MAX_RESTORED_TABS = 256;
const RESTORE_READ_CONCURRENCY = 32;
const EMPTY_PERSIST_PATHS: string[] = [];

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
  return findWindowEntryBySeq(snap.windows, windowSeq);
}

export function collectNormalizedWorkspaceRoots(
  roots: readonly unknown[],
): string[] {
  if (roots.length === 0) return EMPTY_PERSIST_PATHS;
  let out: string[] | null = null;
  let count = 0;
  for (const raw of roots) {
    const normalized = normalizeWorkspaceRoot(raw);
    if (normalized !== null) {
      out ??= new Array<string>(roots.length);
      out[count++] = normalized;
    }
  }
  if (out === null) return EMPTY_PERSIST_PATHS;
  out.length = count;
  return out;
}

export function collectEditorSnapshot(
  tabs: readonly EditorTab[],
  activeTabId: string | null,
): { openFilePaths: string[]; activePath: string | null } {
  if (tabs.length === 0) {
    return { openFilePaths: EMPTY_PERSIST_PATHS, activePath: null };
  }
  let openFilePaths: string[] | null = null;
  let count = 0;
  let activePath: string | null = null;
  for (const tab of tabs) {
    if (tab.filePath !== null) {
      openFilePaths ??= new Array<string>(tabs.length);
      openFilePaths[count++] = tab.filePath;
      if (tab.id === activeTabId) activePath = tab.filePath;
    }
  }
  if (openFilePaths === null) {
    return { openFilePaths: EMPTY_PERSIST_PATHS, activePath };
  }
  openFilePaths.length = count;
  return { openFilePaths, activePath };
}

export function copyPersistPaths(paths: readonly string[]): string[] {
  if (paths.length === 0) return EMPTY_PERSIST_PATHS;
  const out = new Array<string>(paths.length);
  for (let i = 0; i < paths.length; i++) {
    out[i] = paths[i]!;
  }
  return out;
}

export function copyPersistPathSet(paths: ReadonlySet<string>): string[] {
  if (paths.size === 0) return EMPTY_PERSIST_PATHS;
  const out = new Array<string>(paths.size);
  let index = 0;
  for (const path of paths) {
    out[index++] = path;
  }
  return out;
}

export function snapshotFromStores(
  /** Phase 2A 默认主窗段;Phase 2B 调用方传当前窗口 windowSeq + 已有段合并写回. */
  prevSnap?: ExplorerSnapshot,
  windowSeq: number = PRIMARY_WINDOW_SEQ,
): ExplorerSnapshot {
  // 边界(E137,E8 同族):windowSeq 须非负安全整数。query 解析处(initial-workspace E8)已守卫,
  // 但本函数是导出 API、且 `windowSeq + 1`(下方 nextWindowSeq)对 unsafe integer 会因 IEEE-754
  // 精度 no-op/碰撞,污染 nextWindowSeq 与窗口段索引(新窗复用 seq / 段匹配错乱)。在使用点防御性
  // 兜底:非法 → 回退主窗位(fail-closed)。对正常(始终安全)调用为 no-op。
  const seq =
    Number.isSafeInteger(windowSeq) && windowSeq >= 0
      ? windowSeq
      : PRIMARY_WINDOW_SEQ;
  const w = useWorkspaceStore.getState();
  const e = useExplorerStore.getState();
  const p = usePinnedStore.getState();
  const ui = useLayoutUiStore.getState();
  const ed = useEditorStore.getState();
  // 过滤掉 untitled tab(filePath=null)— 没有路径无法恢复
  const { openFilePaths, activePath } = collectEditorSnapshot(
    ed.tabs,
    ed.activeTabId,
  );
  const root = normalizeWorkspaceRoot(w.root);
  const recentRoots = collectNormalizedWorkspaceRoots(w.recentRoots);

  const myEntry: ExplorerWindowEntry = {
    windowSeq: seq,
    workspace: { root },
    explorer: {
      // activePath 已不在 runtime store(打磨 R18:无生产 setter/reader)。磁盘
      // schema 维持兼容,继续写保留位 null;旧数据里的值在 hydrate 时被忽略。
      activePath: null,
      expandedPaths: copyPersistPathSet(e.expandedPaths),
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
    prevSnap?.nextWindowSeq ?? seq + 1,
    seq + 1,
  );

  return {
    version: VERSION,
    workspace: { recentRoots },
    pinned: { paths: copyPersistPaths(p.paths) },
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
    recentRoots: collectNormalizedWorkspaceRoots(snap.workspace.recentRoots),
  });
  usePinnedStore.setState({
    paths: copyPersistPaths(snap.pinned.paths),
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
  // 边界(E216):截断到 MAX_RESTORED_TABS —— 超量 openFilePaths(畸形/旧快照,schema 允许至多 100k)
  // 不一次性恢复;canonical snapshot 下次持久化按恢复集写回,逐步收敛掉超量路径。
  const allPaths = entry.editor.openFilePaths;
  const pathCount = Math.min(allPaths.length, MAX_RESTORED_TABS);
  const paths = new Array<string>(pathCount);
  for (let i = 0; i < pathCount; i++) {
    paths[i] = allPaths[i]!;
  }
  // 数据安全(codex 复查 P2):必须 allSettled,不能 Promise.all —— readFile 的 promise 若
  // reject(桥/进程/通道异常,非 handler 的 {ok:false}),Promise.all 会整轮抛 → 违反
  // 本函数「不抛、单文件失败静默跳过」契约 → initExplorerPersistence catch 后 0 tab,
  // 下次变化把 editor.openFilePaths 写成空数组 → 丢掉本可恢复的整个编辑会话。allSettled
  // 把 reject 当作该文件失败逐项跳过,保留其它成功恢复的 tab。
  // 边界(E216):固定 worker 池并发读,峰值并发钳到 RESTORE_READ_CONCURRENCY(不一次性 fan-out 全部 readFile)。
  const settled = await allSettledWithConcurrency(
    paths,
    RESTORE_READ_CONCURRENCY,
    (path) => fs.readFile(path),
  );
  // 跨平台(codex 复查 P2,pathEquals 相等族):root 守卫须用平台感知相等,不能字节级 `!==`。
  // expectedRoot / currentRoot 均经 normalizeWorkspaceRoot,可能为 null。Windows 文件系统
  // 大小写不敏感,恢复在途若同一文件夹以不同大小写被(重新)设为 root,字节比较会误判
  // 「已切到别 workspace」→ 整轮跳过恢复 → 后续把 openFilePaths 写空。POSIX 仍大小写敏感。
  const currentRoot = useWorkspaceStore.getState().root;
  const rootChanged =
    expectedRoot === null
      ? currentRoot !== null
      : currentRoot === null || !pathEquals(currentRoot, expectedRoot);
  if (rootChanged) return;
  const store = useEditorStore.getState();
  for (let i = 0; i < paths.length; i++) {
    const s = settled[i];
    if (!s || s.status !== 'fulfilled') continue; // reject → 当失败跳过(不抛)
    const r = s.value;
    if (!r || !r.ok) continue;
    store.openTab(createTab(paths[i]!, r.data));
  }
  // 重读最新 store(openTab 改了状态)
  const next = useEditorStore.getState();
  const desired = entry.editor.activePath;
  if (desired && hasEditorTabWithId(next.tabs, desired)) {
    next.switchTab(desired);
  }
}

export function hasEditorTabWithId(
  tabs: readonly { readonly id: string }[],
  id: string,
): boolean {
  for (const tab of tabs) {
    if (tab.id === id) return true;
  }
  return false;
}

// 防御性 schema 校验(主进程已校验,这里给 init 流程兜底,失败就不 hydrate)。
// 可维护性 M15:复用 main/renderer **共享**的 zod schema(electron/shared/
// explorer-persistence-schema),不再手写谓词。接受 v2 或 v3(与旧谓词 version===2||3
// 一致);校验比旧手写版更严(元素类型 / int / strict),合法数据(主进程写的)行为不变,
// 仅更早拒损坏数据。类型守卫返回 `v is ExplorerSnapshot`(磁盘契约即此 renderer 形态)。
function isExplorerSnapshot(v: unknown): v is ExplorerSnapshot {
  return (
    ExplorerSchema.safeParse(v).success || ExplorerSchemaV3.safeParse(v).success
  );
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

  // race(R38):捕获启动 root 选择代际。initExplorerPersistence 是 fire-and-forget,UI 在
  // `await api.read()` 完成前就以 root=null 渲染、可交互;冷启动磁盘/IPC 慢时用户可能经
  // EmptyWorkspace/drop/recent 选了新 workspace(setRoot,经 workspaceRootSelectionGuard begin)。
  // 此时迟到的 hydrate 会用旧 snapshot 覆盖用户选择(root/recent/pinned/layout/editor)+ 随后写订阅
  // 持久化错误 workspace。begin() 把本次启动恢复登记为「当前 root 选择」;若 read 期间有任何用户
  // root 选择(或同步 root 变更)发生,下方 isLatestRootSelection() 为 false → 跳过迟到 hydrate,
  // 但仍注册写订阅持久化用户的当前选择。与 R27/R28 共用同一守卫(全局 last-wins)。
  const isLatestRootSelection = workspaceRootSelectionGuard.begin();

  // 1. read + sync hydrate(失败不 crash)
  let hydratedSnap: ExplorerSnapshot | null = null;
  // 数据安全(codex 复查 P1):区分「可信加载」与「读失败」。read ok(含首启无文件 null /
  // 合法 snapshot / 损坏都算成功读到磁盘当前态)→ 可信;!ok(EACCES/EIO 经 safeHandle)/
  // reject → 磁盘真实态未知、store 仍默认态,**不可信**。仅可信时才注册写订阅(见步骤 3)。
  let loadTrusted = false;
  try {
    const r = await api.read();
    if (r.ok) {
      loadTrusted = true;
      if (!isLatestRootSelection()) {
        // race(R38):read 期间用户已选新 workspace(EmptyWorkspace/drop/recent)→ 迟到的本次 hydrate
        // 是过期请求,跳过所有 hydrate-into-stores(及随后 editor tabs restore,因 hydratedSnap 保持
        // null),避免用旧 snapshot 覆盖用户选择;loadTrusted 仍为 true,下方照常注册写订阅持久化新选择。
        console.warn(
          '[explorer-persist] user selected workspace during hydrate — skip stale restore',
        );
      } else if (r.data && isExplorerSnapshot(r.data)) {
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
        // 读成功但无 explorer.json / 损坏 → 按新窗 default 处理(既有契约)
        hydrateStoresForNewWindow(null, initialWorkspace);
      }
    } else {
      // read 失败:不 hydrate、不可信(下方跳过写订阅,避免用默认态覆盖磁盘真实数据)
      console.warn('[explorer-persist] read not ok', r.code, r.message);
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

  // 数据安全(codex 复查 P1):仅在「可信加载」后才注册写订阅/flush。read 失败(!ok/reject)
  // 时磁盘真实态未知、store 仍默认/未恢复态:若注册写订阅,后续任意 root/tab/expanded 变化会把
  // 默认态 snapshot 写回 → main 端 explorer:write 重读 merge 后把真实 recentRoots/pinned/
  // window/editor 段覆盖为空/默认。不可信 → 不订阅、不 flush,留待下次重启重读恢复(磁盘不动)。
  if (!loadTrusted) {
    console.warn(
      '[explorer-persist] load not trusted (read failed) — skip write subscription to avoid clobbering on-disk data',
    );
    return;
  }

  // 3. 订阅 + debounce 写。所有窗口都订阅,各写各段(prevSnap 合并保留其它段)。
  let lastSnap: ExplorerSnapshot | null = hydratedSnap;
  // race(R87):单飞写链。debounce 自动写与关窗 flush(activeFlush)可并发提交不同时间点的
  // snapshot;此前各自 snapshotFromStores 后裸 await api.write 无序列化 —— 慢盘/IPC 下旧 snapshot
  // 的 write 可能后进 main 文件 mutex,main 只互斥不判新旧 → 旧窗口段覆盖新 → 刚开/关的 tab、
  // expandedPaths、workspace UI 态被回滚。改为:同一窗口一次只允许一个 api.write 在途(链串行);
  // snapshotFromStores 在链节执行时(而非入队时)读 → 总是写当下最新态;pendingWrite 合并冗余写。
  // flush 返回链尾 promise → 关窗仍能 await 到最终写完成。
  let writeChain: Promise<void> = Promise.resolve();
  let pendingWrite = false;
  let lastWrittenSnapshotPayload: string | null = null;
  let hasDirtyStoreChanges = true;
  const writeNow = (): Promise<void> => {
    if (!hasDirtyStoreChanges && !pendingWrite) return writeChain;
    pendingWrite = true;
    writeChain = writeChain.then(async () => {
      if (!pendingWrite) return; // 已被链上前一个写覆盖(合并),跳过冗余写
      pendingWrite = false;
      try {
        const snap = snapshotFromStores(lastSnap ?? undefined, windowSeq);
        const serializedSnap = JSON.stringify(snap);
        if (serializedSnap === lastWrittenSnapshotPayload) {
          hasDirtyStoreChanges = false;
          return;
        }
        const w = await api.write(snap);
        if (w.ok) {
          lastSnap = snap;
          lastWrittenSnapshotPayload = serializedSnap;
          hasDirtyStoreChanges = false;
        } else {
          console.warn('[explorer-persist] write failed', w.code, w.message);
        }
      } catch (err) {
        console.warn('[explorer-persist] write threw', err);
      }
    });
    return writeChain;
  };
  const persist = debounce(() => {
    void writeNow();
  }, DEBOUNCE_MS);
  // 注册立即落盘句柄,供 flushExplorerPersistence()(关窗 / 退出)调用。
  activeFlush = writeNow;

  const markDirtyAndPersist = (): void => {
    hasDirtyStoreChanges = true;
    persist();
  };

  subscribeAll(
    [
      useWorkspaceStore,
      useExplorerStore,
      usePinnedStore,
      useLayoutUiStore,
      useEditorStore,
    ],
    markDirtyAndPersist,
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
      ? collectNormalizedWorkspaceRoots(snap.workspace.recentRoots)
      : [],
  });
  // 主窗段的 sort 拿来当默认(同项目两窗口偏好排序应一致),无则 by:name
  const primary = snap ? findWindowEntry(snap, PRIMARY_WINDOW_SEQ) : null;
  useExplorerStore.setState({
    expandedPaths: new Set(),
    sort: primary ? primary.explorer.sort : { by: 'name', reverse: false },
  });
  usePinnedStore.setState({
    paths: snap ? copyPersistPaths(snap.pinned.paths) : EMPTY_PERSIST_PATHS,
  });
  useLayoutUiStore.setState({
    sidebarOpen: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  });
}
