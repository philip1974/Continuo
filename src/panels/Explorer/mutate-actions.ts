// 资源管理器 CRUD 动作层(Step 5)。
// 把 IPC 调用 + tree 刷新封装成单一动作,组件 onClick 只调一次,无需写状态机。
// 所有失败结构化返回(从 IpcResult 透传 code/message),组件层弹 toast/inline 错误。

import type { FsApi } from '@/lib/fs/api';
import { dirname, outermostPaths } from './path-utils';
import { allSettledWithConcurrency } from '@/lib/map-with-concurrency';
import { failureOf } from '@/lib/failure-of';

// 批量删除的最大在途 IPC 数(trash 走 shell.trashItem,过高并发对回收站/磁盘无益)。
const REMOVE_CONCURRENCY = 4;

// 删除目标已不存在的错误码(main 业务码 / 原始 errno)。
const GONE_CODES: ReadonlySet<string> = new Set(['FS_NOT_FOUND', 'ENOENT']);

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
  // IPC reject 归类成结构化失败(同 createEntry),helper 恒返回 ActionResult。
  let r;
  try {
    r = await deps.fs.rename(oldPath, newName);
  } catch (err) {
    return toActionFail(err);
  }
  if (!r.ok) return { ok: false, code: r.code, message: r.message };
  tree.invalidateChildrenIds(dirname(oldPath));
  return { ok: true, newPath: r.data };
}

// ────────────────────────────────────────────────────────────
// remove(移到系统回收站)
// ────────────────────────────────────────────────────────────

export function removeItems(
  paths: ReadonlyArray<string>,
  deps: MutateDeps,
  tree: TreeMutationApi,
): Promise<RemoveResult> {
  return removeEach(paths, (p) => deps.fs.trash(p), tree);
}

/** 移到废纸篓 / 永久删除共用的批量删除:remove 是单项 IPC。 */
async function removeEach(
  paths: ReadonlyArray<string>,
  remove: (p: string) => ReturnType<FsApi['trash']>,
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
  const outcomes = await allSettledWithConcurrency(targets, REMOVE_CONCURRENCY, remove);
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i]!;
    const outcome = outcomes[i]!;
    // a11y(A137 同族):trash/remove 的 IPC reject(抛错而非返回 {ok:false})此前未捕获 →
    // removeItems 整体 reject;而调用点(Explorer onTrash)是 fire-and-forget async 不被
    // await → unhandled rejection + 该项不计入 failures → 批量删除错误反馈漏报。归类到
    // failures(镜像 !r.ok 分支),removeItems 自此恒返回 RemoveResult 不 reject。
    const failure =
      outcome.status === 'rejected'
        ? toActionFail(outcome.reason)
        : outcome.value.ok
          ? null
          : outcome.value;
    // 已不存在(如确认框打开期间被外部删除)= 目的已达成:按已删除处理(刷新父目录、关 tab 等清理),不报错。
    if (failure === null || GONE_CODES.has(failure.code)) {
      successParents.add(dirname(p));
      removed.push(p);
    } else {
      failures[failureCount++] = { path: p, code: failure.code, message: failure.message };
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

/**
 * 移到回收站 + 清理。只清理实际删掉的路径(result.removed),不遍历原始选择:多选 A 与 A/B 时 A/B
 * 被折叠,删 A 失败则 A/B 也没删,但它不在 failures 里,按「原始选择 − failures」会被误当成功。
 */
export async function trashItemsAndCleanup(
  paths: ReadonlyArray<string>,
  deps: MutateDeps,
  tree: TreeMutationApi,
  /** 「路径已删除」清理(Explorer onTrash 注入 path-gone-cleanup);批量一次完成(perf:免 R 次全 tab 扫描 + R 次 set)。 */
  cleanup: (removed: string[]) => void,
): Promise<RemoveResult> {
  const result = await removeItems(paths, deps, tree);
  if (result.removed.length > 0) cleanup(result.removed);
  return result;
}

/**
 * 永久删除 + 清理(不可撤销;只在「无法移到废纸篓,是否永久删除?」确认后调用,VSCode deleteFiles 的 Delete Permanently)。
 * 失败收集 / 已不存在当成功 / 刷新父目录 / 「路径已删除」清理与 trashItemsAndCleanup 同一套。
 */
export async function deleteItemsPermanentlyAndCleanup(
  paths: ReadonlyArray<string>,
  deps: { fs: Pick<FsApi, 'deletePermanently'> },
  tree: TreeMutationApi,
  cleanup: (removed: string[]) => void,
): Promise<RemoveResult> {
  const result = await removeEach(paths, (p) => deps.fs.deletePermanently(p), tree);
  if (result.removed.length > 0) cleanup(result.removed);
  return result;
}

// a11y(A139,A138/A137 同族):createFile/createDir 的 IPC reject(抛错而非返回 {ok:false})
// 此前未捕获 → helper 整体 reject;而调用点 submitCreate 是 fire-and-forget async,reject 即
// unhandled rejection + 不进 !r.ok 分支 → 新建文件/文件夹失败无 toast/live region 反馈。
// catch 归类成 ActionFail(code 取 err.code ?? 'EXCEPTION'),helper 自此恒返回 ActionResult。
function toActionFail(err: unknown): ActionFail {
  const { code, message } = failureOf(err);
  return { ok: false, code, message: message ?? code };
}

// 新建文件 / 目录同构(只差调哪个 fs 方法):IPC reject → 结构化失败;成功 → 刷新新建最上层项所在目录(名字带中间目录
// `a/b/c.ts` 时那是 parentDir 或其下已存在的中间目录)。created = 本次新建的最上层项(见 FsCreated)。
async function createEntry(
  create: (parentDir: string, name: string) => ReturnType<MutateDeps['fs']['createFile']>,
  parentDir: string,
  name: string,
  tree: TreeMutationApi,
): Promise<ActionResult<{ newPath: string; created: string }>> {
  let r;
  try {
    r = await create(parentDir, name);
  } catch (err) {
    return toActionFail(err);
  }
  if (!r.ok) return { ok: false, code: r.code, message: r.message };
  tree.invalidateChildrenIds(dirname(r.data.created));
  return { ok: true, newPath: r.data.path, created: r.data.created };
}

export function createNewFile(
  parentDir: string,
  name: string,
  deps: MutateDeps,
  tree: TreeMutationApi,
): Promise<ActionResult<{ newPath: string; created: string }>> {
  return createEntry((d, n) => deps.fs.createFile(d, n), parentDir, name, tree);
}

export function createNewDir(
  parentDir: string,
  name: string,
  deps: MutateDeps,
  tree: TreeMutationApi,
): Promise<ActionResult<{ newPath: string; created: string }>> {
  return createEntry((d, n) => deps.fs.createDir(d, n), parentDir, name, tree);
}
