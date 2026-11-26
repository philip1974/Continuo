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

/** 窗口段 → 快照(工作区相关部分 + dock 布局);没有 root 的段(空窗口)→ null。 */
export function snapshotOfWindowEntry(entry: WindowEntryV3): WorkspaceSnapshot | null {
  const root = entry.workspace.root;
  if (root === null) return null;
  const { windowSeq: _seq, lastClosedAt: _closed, windowState: _state, workspace: _ws, ...rest } = entry;
  return { workspace: { root }, ...rest };
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
  return i === -1 ? null : list[i]!;
}

/** 存入 / 替换该 root 的快照并置顶(最近使用在前),超出上限淘汰最旧。返回快照表是否改变(调用方据此决定写盘)。 */
export async function upsertWorkspaceSnapshot(
  payload: ExplorerPayloadV3,
  snapshot: WorkspaceSnapshot,
  deps?: FindWorkspaceWindowDeps,
): Promise<boolean> {
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
