// 资源管理器持久化层(M-Explorer Step 3 / ADR-012)。
// 职责:启动时从 IPC 读 explorer.json hydrate 三 store;
// 三 store 任一变化 → debounce 300ms 写回 IPC。
//
// 持久化字段范围(VSCode 风):
//   ✅ workspace.root / recentRoots
//   ✅ explorer.activePath / expandedPaths / sort
//   ✅ pinned.paths
//   ❌ explorer.selectedPaths / lastAnchorPath / search(瞬时态)
//
// 数据形态:磁盘 JSON 全用 array,store 内部 expandedPaths 用 Set。
// snapshot/hydrate 负责 Set ↔ array 互转。

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
}

export interface ExplorerPersistApi {
  read: () => Promise<IpcResult<unknown | null>>;
  write: (snap: ExplorerSnapshot) => Promise<IpcResult<void>>;
}

// ──────────────────────────────────────────────
// snapshotFromStores / hydrateStores
// ──────────────────────────────────────────────

export function snapshotFromStores(): ExplorerSnapshot {
  const w = useWorkspaceStore.getState();
  const e = useExplorerStore.getState();
  const p = usePinnedStore.getState();
  const ui = useLayoutUiStore.getState();
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
    // 瞬时态显式复位:防止 hydrate 后残留上一次会话的 select/search
    selectedPaths: new Set(),
    lastAnchorPath: null,
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
): Promise<void> {
  // 1. read + hydrate(失败不 crash)
  try {
    const r = await api.read();
    if (r.ok && r.data && isExplorerSnapshot(r.data)) {
      hydrateStores(r.data);
    }
  } catch (err) {
    console.warn('[explorer-persist] read failed', err);
  }

  // 2. 订阅 + debounce 写
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
}
