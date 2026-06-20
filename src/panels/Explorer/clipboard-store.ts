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
        const isRemoved = (p: string): boolean =>
          removedPaths.some(
            (r) => p === r || p.startsWith(r + '/') || p.startsWith(r + '\\'),
          );
        const remaining = s.paths.filter((p) => !isRemoved(p));
        if (remaining.length === s.paths.length) return s; // 无变化 → 引用不变,免重渲
        if (remaining.length === 0) return { kind: null, paths: [] };
        return { kind: s.kind, paths: remaining };
      }),
  }),
);
