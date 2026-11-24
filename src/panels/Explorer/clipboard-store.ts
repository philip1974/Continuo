// Explorer in-app 剪贴板(剪切 / 复制 / 粘贴)。
// 不走系统剪贴板 — 只在 Continuo 内有效。VSCode 同款做法。
//
// 状态:
//   { kind: 'cut' | 'copy', paths: string[] } — 待粘贴的路径集
//   null = 空
//
// cut 粘贴成功后剪除已移走的源(prune,避免重复 move 同一文件)。
// copy 粘贴成功后保留(允许多次粘贴到不同位置)。

import { create } from 'zustand';
import { containmentFold, containmentKey, someContainmentCandidate } from '@/lib/path-cross';
import { arraysEqual } from '@shared/array-equal';

export type ClipboardKind = 'cut' | 'copy';

const EMPTY_CLIPBOARD_PATHS: readonly string[] = [];

interface ExplorerClipboardState {
  kind: ClipboardKind | null;
  paths: readonly string[];
  set(kind: ClipboardKind, paths: readonly string[]): void;
  /**
   * 删除/改名/移动后,把已不存在于原路径的源剪除出剪贴板(含被删/移走目录下的子
   * 路径)。剪空则一并清掉 kind。否则剪切了文件 A 后删除/改名/移走 A,剪贴板仍引用
   * 旧路径 A → Paste 菜单仍可点(粘贴时 move 不存在路径报错)+ 同路径新建文件被误
   * 灰显为「待粘贴」。匹配语义对齐 editor.store getStateAfterRemovingPath(精确等于
   * 或目录前缀 `path + '/'|'\\'`)。
   */
  prune(removedPaths: readonly string[]): void;
}

function copyClipboardPaths(paths: readonly string[]): readonly string[] {
  if (paths.length === 0) return EMPTY_CLIPBOARD_PATHS;
  const copied = new Array<string>(paths.length);
  for (let i = 0; i < paths.length; i++) copied[i] = paths[i]!;
  return copied;
}

function clipboardPathsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return arraysEqual(a, b);
}

export function pruneClipboardPaths(
  paths: readonly string[],
  removedPaths: readonly string[],
): readonly string[] {
  if (paths.length === 0) return EMPTY_CLIPBOARD_PATHS;
  // perf:原为 clipboard × removed 两两 isSameOrInsidePath。改为把 removed 的比较键建 Set,
  // 每个剪贴板路径只查其 O(depth) 个候选祖先键;与「存在 removed 覆盖该路径」精确等价。
  const fold = containmentFold();
  const removedKeys = new Set<string>();
  for (const removedPath of removedPaths) removedKeys.add(containmentKey(removedPath, fold));
  const isRemovedKey = (key: string): boolean => removedKeys.has(key);
  const isRemoved = (path: string): boolean =>
    removedKeys.has('') || someContainmentCandidate(fold(path), isRemovedKey);
  let remaining: string[] | null = null;
  let remainingCount = 0;
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    if (isRemoved(path)) {
      if (remaining === null) {
        remaining = new Array<string>(paths.length - 1);
        for (let j = 0; j < i; j++) remaining[remainingCount++] = paths[j]!;
      }
      continue;
    }
    if (remaining !== null) remaining[remainingCount++] = path;
  }
  if (remaining === null) return paths;
  remaining.length = remainingCount;
  return remainingCount === 0 ? EMPTY_CLIPBOARD_PATHS : remaining;
}

// perf:FileRow 每个可见行要判「是否已剪切」;对 paths 数组线性 includes 在剪切海量项后滚动每帧
// O(行数 × 剪切数)。paths 在 store 内不可变(set 复制、prune 产新数组),按数组引用派生缓存 Set,
// 同一 paths 只建一次,判定 O(1);Set.has 与 includes 同为 SameValueZero(精确字符串相等)。
const clipboardPathSets = new WeakMap<readonly string[], ReadonlySet<string>>();

export function clipboardPathSet(paths: readonly string[]): ReadonlySet<string> {
  let set = clipboardPathSets.get(paths);
  if (set === undefined) {
    set = new Set(paths);
    clipboardPathSets.set(paths, set);
  }
  return set;
}

export const useExplorerClipboardStore = create<ExplorerClipboardState>(
  (set) => ({
    kind: null,
    paths: EMPTY_CLIPBOARD_PATHS,
    set: (kind, paths) =>
      set((s) =>
        s.kind === kind && clipboardPathsEqual(s.paths, paths)
          ? s
          : { kind, paths: copyClipboardPaths(paths) },
      ),
    prune: (removedPaths) =>
      set((s) => {
        if (s.kind === null || s.paths.length === 0 || removedPaths.length === 0) {
          return s;
        }
        // 跨平台(复查 P2):复用单一来源 path-cross.isSameOrInsidePath —— 此前手写
        // 大小写敏感前缀,Windows 上剪贴板源与删除/改名旧路径仅大小写不同时不剪除 → 保留失效
        // 源 → Paste 报不存在/同路径新建文件误灰显待粘贴。匹配语义同 editor.store remove/rename。
        const remaining = pruneClipboardPaths(s.paths, removedPaths);
        if (remaining === s.paths) return s; // 无变化 → 引用不变,免重渲
        if (remaining.length === 0) {
          return { kind: null, paths: EMPTY_CLIPBOARD_PATHS };
        }
        return { kind: s.kind, paths: remaining };
      }),
  }),
);
