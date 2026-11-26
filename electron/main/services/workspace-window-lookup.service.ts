// 「这个文件夹已在哪个主窗口里打开」的判定(VSCode windowsMainService.findWindowOnWorkspaceOrFolder 同语义):
// 打开一个已在某窗口打开的文件夹时聚焦那个窗口,而不是在当前窗口 / 新窗口里再开一份(同一工作区两窗互相覆盖
// 会话、终端 cwd、文件监听)。比较前两侧都先 realpath(软链 / `..` 指向同一目录算同一工作区;realpath 失败用原值),
// 再按平台语义比较(isSameOrInsidePath 双向 = 相等:分隔符 / 尾分隔符无关,Windows 大小写不敏感)。
// BDD: src/__tests__/workspace-window-dedupe/

import fs from 'node:fs/promises';
import { isSameOrInsidePath } from '../lib/path-inside';

export interface WorkspaceWindowCandidate {
  readonly windowId: number;
  readonly root: string;
}

export interface FindWorkspaceWindowDeps {
  readonly realpath?: (p: string) => Promise<string>;
  readonly platform?: NodeJS.Platform;
}

/** 两个已规范化的路径是否同一目录(平台感知;双向包含 = 相等)。 */
export function isSameWorkspacePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return isSameOrInsidePath(a, b, platform) && isSameOrInsidePath(b, a, platform);
}

async function canonical(p: string, realpath: (p: string) => Promise<string>): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/**
 * 在 `candidates`(各主窗当前 workspace root)里找与 `root` 是同一目录的窗口;返回其 windowId,没有则 null。
 * 无候选时不做任何 realpath(常见情形:只开了一个窗口)。
 */
export async function findWindowWithWorkspace(
  root: string,
  candidates: readonly WorkspaceWindowCandidate[],
  deps: FindWorkspaceWindowDeps = {},
): Promise<number | null> {
  if (candidates.length === 0) return null;
  const realpath = deps.realpath ?? ((p: string) => fs.realpath(p));
  const platform = deps.platform ?? process.platform;
  const target = await canonical(root, realpath);
  const roots = await Promise.all(candidates.map((c) => canonical(c.root, realpath)));
  for (let i = 0; i < candidates.length; i += 1) {
    if (isSameWorkspacePath(roots[i]!, target, platform)) return candidates[i]!.windowId;
  }
  return null;
}
