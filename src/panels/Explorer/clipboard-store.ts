// Explorer in-app 剪贴板(剪切 / 复制 / 粘贴)。
// 不走系统剪贴板 — 只在 Continuo 内有效。VSCode 同款做法。
//
// 状态:
//   { kind: 'cut' | 'copy', paths: string[] } — 待粘贴的路径集
//   null = 空
//
// cut 粘贴成功后自动 clear(避免重复 move 同一文件)。
// copy 粘贴成功后保留(允许多次粘贴到不同位置)。

import { create } from 'zustand';
import { isSameOrInsidePath } from '@/lib/path-cross';

export type ClipboardKind = 'cut' | 'copy';

interface ExplorerClipboardState {
  kind: ClipboardKind | null;
  paths: readonly string[];
  set(kind: ClipboardKind, paths: readonly string[]): void;
  clear(): void;
  /**
   * 删除/改名/移动后,把已不存在于原路径的源剪除出剪贴板(含被删/移走目录下的子
   * 路径)。剪空则一并清掉 kind。否则剪切了文件 A 后删除/改名/移走 A,剪贴板仍引用
   * 旧路径 A → Paste 菜单仍可点(粘贴时 move 不存在路径报错)+ 同路径新建文件被误
   * 灰显为「待粘贴」。匹配语义对齐 editor.store getStateAfterRemovingPath(精确等于
   * 或目录前缀 `path + '/'|'\\'`)。
   */
  prune(removedPaths: readonly string[]): void;
}

function isClipboardPathRemoved(path: string, removedPaths: readonly string[]): boolean {
  for (const removedPath of removedPaths) {
    if (isSameOrInsidePath(removedPath, path)) return true;
  }
  return false;
}

export function pruneClipboardPaths(
  paths: readonly string[],
  removedPaths: readonly string[],
): readonly string[] {
  let remaining: string[] | null = null;
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    if (isClipboardPathRemoved(path, removedPaths)) {
      if (remaining === null) {
        remaining = [];
        for (let j = 0; j < i; j++) {
          remaining.push(paths[j]!);
        }
      }
      continue;
    }
    if (remaining !== null) remaining.push(path);
  }
  return remaining ?? paths;
}

export const useExplorerClipboardStore = create<ExplorerClipboardState>(
  (set) => ({
    kind: null,
    paths: [],
    set: (kind, paths) => set({ kind, paths: [...paths] }),
    clear: () => set({ kind: null, paths: [] }),
    prune: (removedPaths) =>
      set((s) => {
        if (s.kind === null || s.paths.length === 0 || removedPaths.length === 0) {
          return s;
        }
        // 跨平台(codex 复查 P2):复用单一来源 path-cross.isSameOrInsidePath —— 此前手写
        // 大小写敏感前缀,Windows 上剪贴板源与删除/改名旧路径仅大小写不同时不剪除 → 保留失效
        // 源 → Paste 报不存在/同路径新建文件误灰显待粘贴。匹配语义同 editor.store remove/rename。
        const remaining = pruneClipboardPaths(s.paths, removedPaths);
        if (remaining === s.paths) return s; // 无变化 → 引用不变,免重渲
        if (remaining.length === 0) return { kind: null, paths: [] };
        return { kind: s.kind, paths: remaining };
      }),
  }),
);
