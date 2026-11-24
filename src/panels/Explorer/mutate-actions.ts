// 资源管理器 CRUD 动作层(Step 5)。
// 把 IPC 调用 + tree 刷新封装成单一动作,组件 onClick 只调一次,无需写状态机。
// 所有失败结构化返回(从 IpcResult 透传 code/message),组件层弹 toast/inline 错误。

import type { FsApi } from '@/lib/fs/api';
import { dirname, outermostPaths } from './path-utils';
import { errorCodeOf } from '../../../electron/shared/error-message';
import { allSettledWithConcurrency } from '@/lib/map-with-concurrency';

// 批量删除的最大在途 IPC 数(trash 走 shell.trashItem,过高并发对回收站/磁盘无益)。
const REMOVE_CONCURRENCY = 4;

export interface MutateDeps {
  fs: Pick<FsApi, 'rename' | 'trash' | 'createFile' | 'createDir'>;
}

export interface TreeMutationApi {
  invalidateChildrenIds: (parentPath: string) => void;
}

// ────────────────────────────────────────────────────────────
// 返回类型
// ────────────────────────────────────────────────────────────

export type ActionOk<T> = { ok: true } & T;
export interface ActionFail {
  ok: false;
  code: string;
  message: string;
}
export type ActionResult<T> = ActionOk<T> | ActionFail;

export interface RemoveFailure {
  path: string;
  code: string;
  message: string;
}
// removed:实际删掉的(最外层)路径。调用方的成功后清理(关 editor tab、剪贴板 prune)只能基于它:
// 被 outermostPaths 折叠的后代不单独出现在 failures 里,按「原始选择 − failures」判成功会把失败祖先
// 下的后代误当已删除。
export type RemoveResult =
  | { ok: true; removed: string[] }
  | { ok: false; failures: RemoveFailure[]; removed: string[] };

// ────────────────────────────────────────────────────────────
// rename
// ────────────────────────────────────────────────────────────

export async function renameItem(
  oldPath: string,
  newName: string,
  deps: MutateDeps,
  tree: TreeMutationApi,
): Promise<ActionResult<{ newPath: string }>> {
  const r = await deps.fs.rename(oldPath, newName);
  if (!r.ok) return { ok: false, code: r.code, message: r.message };
  tree.invalidateChildrenIds(dirname(oldPath));
  return { ok: true, newPath: r.data };
}

// ────────────────────────────────────────────────────────────
// remove(移到系统回收站)
// ────────────────────────────────────────────────────────────

export async function removeItems(
  paths: ReadonlyArray<string>,
  deps: MutateDeps,
  tree: TreeMutationApi,
): Promise<RemoveResult> {
  if (paths.length === 0) return { ok: true, removed: [] };

  const failures = new Array<RemoveFailure>(paths.length);
  let failureCount = 0;
  const successParents = new Set<string>();
  const removed: string[] = [];

  // 父目录与其子项同批(多选 A 与 A/B)→ 只删最外层:删 A 已连带 A/B,再删 A/B 必报
  // FS_NOT_FOUND(同 batch-transfer 的嵌套选择族)。被剔的后代不计入 failures,也不进 removed
  //(其祖先删成功则随祖先清理,删失败则后代同样没删)。
  // perf:此前逐项 await(N 次串行 IPC 往返 + 串行 shell.trashItem)。outermostPaths 已保证互不
  // 包含(同一实体不会被两项同时删),改为有界并发;结果按下标记录,汇总/刷新顺序与串行一致。
  const targets = outermostPaths(paths);
  const outcomes = await allSettledWithConcurrency(targets, REMOVE_CONCURRENCY, (p) =>
    deps.fs.trash(p),
  );
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i]!;
    const outcome = outcomes[i]!;
    // a11y(A137 同族):trash/remove 的 IPC reject(抛错而非返回 {ok:false})此前未捕获 →
    // removeItems 整体 reject;而调用点(Explorer onTrash)是 fire-and-forget async 不被
    // await → unhandled rejection + 该项不计入 failures → 批量删除错误反馈漏报。归类到
    // failures(镜像 !r.ok 分支),removeItems 自此恒返回 RemoveResult 不 reject。
    if (outcome.status === 'rejected') {
      const { code, message } = toActionFail(outcome.reason);
      failures[failureCount++] = { path: p, code, message };
      continue;
    }
    const r = outcome.value;
    if (!r.ok) {
      failures[failureCount++] = {
        path: p,
        code: r.code,
        message: r.message,
      };
    } else {
      successParents.add(dirname(p));
      removed.push(p);
    }
  }

  for (const parent of successParents) {
    tree.invalidateChildrenIds(parent);
  }

  if (failureCount === 0) return { ok: true, removed };
  failures.length = failureCount;
  return { ok: false, failures, removed };
}

// ────────────────────────────────────────────────────────────
// create file / dir
// ────────────────────────────────────────────────────────────

/** 删除完成后的清理出口(Explorer onTrash 注入 editor store / 剪贴板 store)。 */
export interface RemoveCleanup {
  /** 关闭这些路径的 editor tab(目录则关其下所有 tab);批量一次完成(perf:免 R 次全 tab 扫描 + R 次 set)。 */
  removePaths(paths: readonly string[]): void;
  /** 从剪贴板剪除已删除的源(避免幻影 cut 灰显 + 失效 Paste)。 */
  prune(paths: string[]): void;
}

/**
 * 移到回收站 + 清理。只清理实际删掉的路径(result.removed),不遍历原始选择:多选 A 与 A/B 时 A/B
 * 被折叠,删 A 失败则 A/B 也没删,但它不在 failures 里,按「原始选择 − failures」会被误当成功。
 */
export async function trashItemsAndCleanup(
  paths: ReadonlyArray<string>,
  deps: MutateDeps,
  tree: TreeMutationApi,
  cleanup: RemoveCleanup,
): Promise<RemoveResult> {
  const result = await removeItems(paths, deps, tree);
  if (result.removed.length > 0) {
    cleanup.removePaths(result.removed);
    cleanup.prune(result.removed);
  }
  return result;
}

// a11y(A139,A138/A137 同族):createFile/createDir 的 IPC reject(抛错而非返回 {ok:false})
// 此前未捕获 → helper 整体 reject;而调用点 submitCreate 是 fire-and-forget async,reject 即
// unhandled rejection + 不进 !r.ok 分支 → 新建文件/文件夹失败无 toast/live region 反馈。
// catch 归类成 ActionFail(code 取 err.code ?? 'EXCEPTION'),helper 自此恒返回 ActionResult。
function toActionFail(err: unknown): ActionFail {
  const code = errorCodeOf(err);
  return { ok: false, code, message: (err as Error)?.message ?? String(err) };
}

// 新建文件 / 目录同构(只差调哪个 fs 方法):IPC reject → 结构化失败;成功 → 刷新父目录。
async function createEntry(
  create: (parentDir: string, name: string) => ReturnType<MutateDeps['fs']['createFile']>,
  parentDir: string,
  name: string,
  tree: TreeMutationApi,
): Promise<ActionResult<{ newPath: string }>> {
  let r;
  try {
    r = await create(parentDir, name);
  } catch (err) {
    return toActionFail(err);
  }
  if (!r.ok) return { ok: false, code: r.code, message: r.message };
  tree.invalidateChildrenIds(parentDir);
  return { ok: true, newPath: r.data };
}

export function createNewFile(
  parentDir: string,
  name: string,
  deps: MutateDeps,
  tree: TreeMutationApi,
): Promise<ActionResult<{ newPath: string }>> {
  return createEntry((d, n) => deps.fs.createFile(d, n), parentDir, name, tree);
}

export function createNewDir(
  parentDir: string,
  name: string,
  deps: MutateDeps,
  tree: TreeMutationApi,
): Promise<ActionResult<{ newPath: string }>> {
  return createEntry((d, n) => deps.fs.createDir(d, n), parentDir, name, tree);
}
