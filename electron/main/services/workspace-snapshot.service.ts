// 按文件夹的会话快照(explorer.json 顶层 workspaceSnapshots;VSCode workspace storage 同语义):窗口段按 windowSeq 存,
// 关掉窗口后再打开同一文件夹 / 同一窗口切走再切回时,按 root 找回上次的编辑器 / 展开 / 侧栏 / 搜索 / dock 布局。
// 写:同一窗口切换 root 前(explorer:switch-workspace)、关窗、退出;用:新窗口打开文件夹(建段,非 fresh)、同一窗口切换 root。
// root 比较与同文件夹去重同一判定(两侧 realpath + 平台语义)。读改写都在 explorer 文件锁内。
// BDD: src/__tests__/workspace-snapshot/

import { isDeepStrictEqual } from 'node:util';
import { withExplorerFileMutex } from '../lib/file-mutex';
import { loadExplorer, promoteRecentRoot, writeExplorerFile } from '../persistence';
import { findWindowWithWorkspace, type FindWorkspaceWindowDeps } from './workspace-window-lookup.service';
import { findWindowEntryBySeq } from '../../shared/window-entry-lookup';
import { utf8ByteLength } from '../../shared/utf8-byte-length';
import { isSameOrInsidePath } from '../lib/path-inside';
import {
  WORKSPACE_SNAPSHOTS_LIMIT,
  type ExplorerPayloadV3,
  type WindowEntryV3,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotState,
  type WorkspaceSwitchInput,
} from '../../shared/explorer-persistence-schema';

/**
 * 单个快照序列化字节上限:超出不存(并移除该 root 的旧快照)。真实快照只有几 KB;单窗 layout 上限 2 MiB,20 份可撑爆
 * explorer.json 的 16 MiB 读上限(之后读写全部失败)。
 */
export const WORKSPACE_SNAPSHOT_MAX_BYTES = 256 * 1024;

type SnapshotEditor = NonNullable<WorkspaceSnapshot['editor']>;
type SnapshotGroup = NonNullable<SnapshotEditor['groups']>[number];

/**
 * 剔除后的活动文件:原活动仍在 → 它;否则 MRU 里下一个仍在的;没有 MRU 记录 → 剩下的最后一个 tab(默认 MRU 顺序:
 * 活动之后按位置从后往前);一个都不剩 → null。
 */
function scopedActive(active: string | null, open: readonly string[], mru: readonly string[] | undefined): string | null {
  if (active !== null && open.includes(active)) return active;
  return mru?.find((p) => open.includes(p)) ?? open.at(-1) ?? null;
}

/** 剔除后的 MRU:不到两项不写(写出端同样只在两项以上时写)。 */
function scopedMru(mru: readonly string[] | undefined, open: readonly string[]): { mruPaths: string[] } | null {
  const kept = mru?.filter((p) => open.includes(p));
  return kept === undefined || kept.length < 2 ? null : { mruPaths: kept };
}

/** 剔除后的固定 tab(一个不剩不写)。 */
function scopedSticky(sticky: readonly string[] | undefined, open: readonly string[]): { stickyPaths: string[] } | null {
  const kept = sticky?.filter((p) => open.includes(p));
  return kept === undefined || kept.length === 0 ? null : { stickyPaths: kept };
}

function scopeEditor(editor: SnapshotEditor, inside: (p: string) => boolean): SnapshotEditor {
  const { openFilePaths, activePath, mruPaths, viewStates, encodings, groups, activeGroup, groupMru, stickyPaths, ...rest } = editor;
  const open = openFilePaths.filter(inside);
  const views = viewStates?.filter((v) => inside(v.path));
  // 用户选定的编码(按文件)同视图状态剔除 root 外的
  const encs = encodings?.filter((e) => inside(e.path));
  const viewsField = {
    ...(views === undefined || views.length === 0 ? null : { viewStates: views }),
    ...(encs === undefined || encs.length === 0 ? null : { encodings: encs }),
  };
  if (groups !== undefined) {
    const kept = groups
      .map((g): SnapshotGroup => {
        const gOpen = g.openFilePaths.filter(inside);
        const gMru = scopedMru(g.mruPaths, gOpen);
        const gActive = scopedActive(g.activePath, gOpen, g.mruPaths);
        return { id: g.id, openFilePaths: gOpen, activePath: gActive, ...gMru, ...scopedSticky(g.stickyPaths, gOpen) };
      })
      .filter((g) => g.openFilePaths.length > 0);
    const active = kept.find((g) => g.id === activeGroup) ?? kept[0];
    // 只剩一个组(或一个不剩)→ 单组形态(写出端只在多于一个组时写 groups)
    if (kept.length > 1) {
      const mru = groupMru?.filter((id) => kept.some((g) => g.id === id));
      return {
        ...rest,
        openFilePaths: open,
        activePath: active!.activePath,
        ...viewsField,
        groups: kept,
        activeGroup: active!.id,
        ...(mru === undefined || mru.length === 0 ? null : { groupMru: mru }),
      };
    }
    return {
      ...rest,
      openFilePaths: open,
      activePath: active?.activePath ?? null,
      ...(active?.mruPaths === undefined ? null : { mruPaths: active.mruPaths }),
      ...(active?.stickyPaths === undefined ? null : { stickyPaths: active.stickyPaths }),
      ...viewsField,
    };
  }
  return {
    ...rest,
    openFilePaths: open,
    activePath: scopedActive(activePath, open, mruPaths),
    ...scopedMru(mruPaths, open),
    ...scopedSticky(stickyPaths, open),
    ...viewsField,
  };
}

/**
 * 快照只含属于该文件夹的路径(VSCode workspace storage 只记该工作区的编辑器):同一窗口切走时按设计保留的未保存 tab
 *(别的文件夹的文件)不记进当前文件夹的快照。剔除 root 外的 tab / 视图状态 / MRU / 展开;活动文件 / 活动组被剔除时降级
 *(见 scopedActive;变空的组丢弃,只剩一个组写单组形态)。dock 布局不含文件路径:多出的编辑器组面板由恢复后的组 ↔ 面板
 * 对齐收掉(editor-groups-dock-sync)。写入、取出都经过这里(旧版本写下的快照取出时同样剔除)。
 * BDD: src/__tests__/workspace-snapshot/
 */
export function scopeWorkspaceSnapshot<T extends WorkspaceSnapshot | WorkspaceSnapshotState>(snapshot: T): T {
  const root = snapshot.workspace.root;
  const inside = (p: string): boolean => isSameOrInsidePath(root, p);
  const { explorer, editor } = snapshot;
  return {
    ...snapshot,
    explorer: {
      ...explorer,
      activePath: explorer.activePath !== null && inside(explorer.activePath) ? explorer.activePath : null,
      expandedPaths: explorer.expandedPaths.filter(inside),
    },
    ...(editor === undefined ? null : { editor: scopeEditor(editor, inside) }),
  };
}

/** 窗口段 → 快照(工作区相关部分 + dock 布局,只含 root 内路径);没有 root 的段(空窗口)→ null。 */
export function snapshotOfWindowEntry(entry: WindowEntryV3): WorkspaceSnapshot | null {
  const root = entry.workspace.root;
  if (root === null) return null;
  // popout 子窗的最大化 / 全屏属于窗口(同 windowState),不随文件夹快照走。
  const { windowSeq: _seq, lastClosedAt: _closed, windowState: _state, popoutWindowModes: _modes, workspace: _ws, ...rest } = entry;
  return scopeWorkspaceSnapshot({ workspace: { root }, ...rest });
}

async function indexOfSnapshot(
  list: readonly WorkspaceSnapshot[],
  root: string,
  deps?: FindWorkspaceWindowDeps,
): Promise<number> {
  // 复用同文件夹去重的判定(候选的 windowId 这里当下标用)。
  const i = await findWindowWithWorkspace(
    root,
    list.map((s, index) => ({ windowId: index, root: s.workspace.root })),
    deps,
  );
  return i ?? -1;
}

export async function findWorkspaceSnapshot(
  payload: ExplorerPayloadV3,
  root: string,
  deps?: FindWorkspaceWindowDeps,
): Promise<WorkspaceSnapshot | null> {
  const list = payload.workspaceSnapshots ?? [];
  const i = await indexOfSnapshot(list, root, deps);
  return i === -1 ? null : scopeWorkspaceSnapshot(list[i]!);
}

/**
 * 存入 / 替换该 root 的快照并置顶(最近使用在前),超出上限淘汰最旧;只存 root 内路径(同一窗口切换的 save 也经这里)。
 * 返回快照表是否改变(调用方据此决定写盘)。
 */
export async function upsertWorkspaceSnapshot(
  payload: ExplorerPayloadV3,
  input: WorkspaceSnapshot,
  deps?: FindWorkspaceWindowDeps,
): Promise<boolean> {
  const snapshot = scopeWorkspaceSnapshot(input);
  const list = payload.workspaceSnapshots ?? [];
  const i = await indexOfSnapshot(list, snapshot.workspace.root, deps);
  const rest = i === -1 ? list : list.filter((_, j) => j !== i);
  const tooLarge = utf8ByteLength(JSON.stringify(snapshot)) > WORKSPACE_SNAPSHOT_MAX_BYTES;
  const next = tooLarge ? rest : [snapshot, ...rest].slice(0, WORKSPACE_SNAPSHOTS_LIMIT);
  if (isDeepStrictEqual(next, list)) return false;
  payload.workspaceSnapshots = next;
  return true;
}

/** 把窗口段存为它 root 的快照(关窗 / 退出 / 段被覆盖前)。返回是否改变。 */
export async function saveWindowEntryAsSnapshot(payload: ExplorerPayloadV3, entry: WindowEntryV3): Promise<boolean> {
  const snapshot = snapshotOfWindowEntry(entry);
  return snapshot === null ? false : await upsertWorkspaceSnapshot(payload, snapshot);
}

/**
 * 新窗口打开 `root` 前(seq 已分配):快照表有这个 root → 把快照写成该 seq 的窗口段(root = 打开的路径;窗口几何保留),
 * 并把 root 置顶「最近打开」,返回新的 recentRoots(调用方广播),窗口随后以非 fresh 打开、按段恢复。
 * 该 seq 已有段(冷启动 dock 模式复用 seq 0)→ 先把原段存为它自己 root 的快照。
 * 没有快照 / explorer.json 不存在或损坏 → null(调用方照旧 fresh)。读失败照常抛(当前态未知,不覆盖)。
 */
export async function seedWindowFromWorkspaceSnapshot(
  explorerFile: string,
  seq: number,
  root: string,
): Promise<string[] | null> {
  return await withExplorerFileMutex(async () => {
    const payload = await loadExplorer(explorerFile);
    if (payload === null) return null;
    const existing = findWindowEntryBySeq(payload.windows, seq);
    const savedExisting = existing !== null && (await saveWindowEntryAsSnapshot(payload, existing));
    const snapshot = await findWorkspaceSnapshot(payload, root);
    if (snapshot === null) {
      if (savedExisting) await writeExplorerFile(explorerFile, payload);
      return null;
    }
    const { workspace: _ws, ...state } = snapshot;
    const entry: WindowEntryV3 = {
      windowSeq: seq,
      workspace: { root },
      ...state,
      ...(existing?.windowState === undefined ? null : { windowState: existing.windowState }),
    };
    payload.windows = existing === null ? [...payload.windows, entry] : payload.windows.map((w) => (w === existing ? entry : w));
    payload.workspace = { ...payload.workspace, recentRoots: promoteRecentRoot(payload.workspace.recentRoots, root) };
    await writeExplorerFile(explorerFile, payload);
    return payload.workspace.recentRoots;
  });
}

/**
 * 同一窗口切换 root(explorer:switch-workspace):把切走前的状态存为旧 root 的快照(dock 布局取盘上本窗段),返回切到的 root
 * 的快照(不含布局:同一窗口切换不换 dock 布局)。explorer.json 还不存在 → 不建文件、返回 null(此时建默认文件会让本窗随后的
 * 整份写回丢掉「最近打开」)。
 */
export async function switchWorkspaceSnapshot(
  explorerFile: string,
  seq: number,
  input: WorkspaceSwitchInput,
): Promise<WorkspaceSnapshotState | null> {
  return await withExplorerFileMutex(async () => {
    const payload = await loadExplorer(explorerFile);
    if (payload === null) return null;
    let changed = false;
    if (input.save !== null) {
      const layout = findWindowEntryBySeq(payload.windows, seq)?.layout;
      changed = await upsertWorkspaceSnapshot(payload, { ...input.save, ...(layout === undefined ? null : { layout }) });
    }
    const found = input.open === null ? null : await findWorkspaceSnapshot(payload, input.open);
    if (changed) await writeExplorerFile(explorerFile, payload);
    if (found === null) return null;
    const { layout: _layout, ...state } = found;
    return state;
  });
}
