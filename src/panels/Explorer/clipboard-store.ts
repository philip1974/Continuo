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
}

export const useExplorerClipboardStore = create<ExplorerClipboardState>(
  (set) => ({
    kind: null,
    paths: [],
    set: (kind, paths) => set({ kind, paths: [...paths] }),
    clear: () => set({ kind: null, paths: [] }),
  }),
);
