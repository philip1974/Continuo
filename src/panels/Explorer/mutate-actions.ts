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
  const failures: RemoveFailure[] = [];
  const successParents = new Set<string>();

  for (const p of paths) {
    const r = useTrash ? await deps.fs.trash(p) : await deps.fs.remove(p);
    if (!r.ok) {
      failures.push({ path: p, code: r.code, message: r.message });
    } else {
      successParents.add(dirname(p));
    }
  }

  for (const parent of successParents) {
    tree.invalidateChildrenIds(parent);
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

// ────────────────────────────────────────────────────────────
// create file / dir
// ────────────────────────────────────────────────────────────

export async function createNewFile(
  parentDir: string,
  name: string,
  deps: MutateDeps,
  tree: TreeMutationApi,
): Promise<ActionResult<{ newPath: string }>> {
  const r = await deps.fs.createFile(parentDir, name);
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
  const r = await deps.fs.createDir(parentDir, name);
  if (!r.ok) return { ok: false, code: r.code, message: r.message };
  tree.invalidateChildrenIds(parentDir);
  return { ok: true, newPath: r.data };
}
