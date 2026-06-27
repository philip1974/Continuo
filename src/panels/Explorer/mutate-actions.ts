// 资源管理器 CRUD 动作层(Step 5)。
// 把 IPC 调用 + tree 刷新封装成单一动作,组件 onClick 只调一次,无需写状态机。
// 所有失败结构化返回(从 IpcResult 透传 code/message),组件层弹 toast/inline 错误。

import type { FsApi } from '@/lib/fs/api';
import { dirname } from './path-utils';

export interface MutateDeps {
  fs: Pick<FsApi, 'rename' | 'remove' | 'trash' | 'createFile' | 'createDir'>;
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
export type RemoveResult =
  | { ok: true }
  | { ok: false; failures: RemoveFailure[] };

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
// remove(默认 trash)
// ────────────────────────────────────────────────────────────

export async function removeItems(
  paths: ReadonlyArray<string>,
  opts: { trash?: boolean },
  deps: MutateDeps,
  tree: TreeMutationApi,
): Promise<RemoveResult> {
  if (paths.length === 0) return { ok: true };

  const useTrash = opts.trash ?? true;
  const failures = new Array<RemoveFailure>(paths.length);
  let failureCount = 0;
  const successParents = new Set<string>();

  for (const p of paths) {
    // a11y(A137 同族):trash/remove 的 IPC reject(抛错而非返回 {ok:false})此前未捕获 →
    // removeItems 整体 reject;而调用点(Explorer onTrash)是 fire-and-forget async 不被
    // await → unhandled rejection + 该项不计入 failures → 批量删除错误反馈漏报。归类到
    // failures(镜像 !r.ok 分支),removeItems 自此恒返回 RemoveResult 不 reject。
    let r;
    try {
      r = useTrash ? await deps.fs.trash(p) : await deps.fs.remove(p);
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'EXCEPTION';
      failures[failureCount++] = {
        path: p,
        code,
        message: (err as Error)?.message ?? String(err),
      };
      continue;
    }
    if (!r.ok) {
      failures[failureCount++] = {
        path: p,
        code: r.code,
        message: r.message,
      };
    } else {
      successParents.add(dirname(p));
    }
  }

  for (const parent of successParents) {
    tree.invalidateChildrenIds(parent);
  }

  if (failureCount === 0) return { ok: true };
  failures.length = failureCount;
  return { ok: false, failures };
}

// ────────────────────────────────────────────────────────────
// create file / dir
// ────────────────────────────────────────────────────────────

// a11y(A139,A138/A137 同族):createFile/createDir 的 IPC reject(抛错而非返回 {ok:false})
// 此前未捕获 → helper 整体 reject;而调用点 submitCreate 是 fire-and-forget async,reject 即
// unhandled rejection + 不进 !r.ok 分支 → 新建文件/文件夹失败无 toast/live region 反馈。
// catch 归类成 ActionFail(code 取 err.code ?? 'EXCEPTION'),helper 自此恒返回 ActionResult。
function toActionFail(err: unknown): ActionFail {
  const code = (err as { code?: string })?.code ?? 'EXCEPTION';
  return { ok: false, code, message: (err as Error)?.message ?? String(err) };
}

export async function createNewFile(
  parentDir: string,
  name: string,
  deps: MutateDeps,
  tree: TreeMutationApi,
): Promise<ActionResult<{ newPath: string }>> {
  let r;
  try {
    r = await deps.fs.createFile(parentDir, name);
  } catch (err) {
    return toActionFail(err);
  }
  if (!r.ok) return { ok: false, code: r.code, message: r.message };
  tree.invalidateChildrenIds(parentDir);
  return { ok: true, newPath: r.data };
}

export async function createNewDir(
  parentDir: string,
  name: string,
  deps: MutateDeps,
  tree: TreeMutationApi,
): Promise<ActionResult<{ newPath: string }>> {
  let r;
  try {
    r = await deps.fs.createDir(parentDir, name);
  } catch (err) {
    return toActionFail(err);
  }
  if (!r.ok) return { ok: false, code: r.code, message: r.message };
  tree.invalidateChildrenIds(parentDir);
  return { ok: true, newPath: r.data };
}
