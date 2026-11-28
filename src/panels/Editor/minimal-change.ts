// 两段文本之间的单段最小替换(去掉公共前后缀):外部重载 / 冲突合并 / 「不保存」关闭时以最小差异把文档换成另一版本(撤销粒度小、
// 光标随变化映射)。VSCode ModelService._computeEdits 同理(它按行 diff,这里取单段)。

import { EditorSelection, type ChangeSet } from '@codemirror/state';

/**
 * prev → next 的单段最小替换(去掉公共前缀与后缀;文档坐标,即 LF 拼接后的文本)。无公共前后缀(整篇不同)/ 无变化
 * → null(调用方整篇替换)。
 */
export function minimalChange(
  prev: string,
  next: string,
): { from: number; to: number; insert: string } | null {
  if (prev === next) return null;
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  // 不把代理对拆在两半(前缀停在高位代理之后 / 后缀起点是低位代理)
  if (p > 0 && isHighSurrogate(prev.charCodeAt(p - 1))) p--;
  if (s > 0 && isLowSurrogate(prev.charCodeAt(prev.length - s))) s--;
  if (p === 0 && s === 0) return null;
  return { from: p, to: prev.length - s, insert: next.slice(p, next.length - s) };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 外部改动(重读磁盘 / 另一编辑器组改了同一文件)后的选区:对齐 VSCode 光标的 TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges
 *(oneCursor.ts):每个选区各自判断,恰在选区边上插入的文本并入选区;空光标并入后折叠到末尾(readSelectionFromMarkers
 * collapseToEnd)—— 光标停在文件末尾时外部追加,光标跟到新末尾(日志跟随);在别处的光标照常随改动映射。不滚动(VSCode 从标记恢复
 * 选区时不 reveal)。CodeMirror 默认映射把边上的插入放到光标 / 选区之外。
 */
export function selectionGrowingAtEdges(selection: EditorSelection, changes: ChangeSet): EditorSelection {
  return EditorSelection.create(
    selection.ranges.map((r) => {
      if (r.empty) return EditorSelection.cursor(changes.mapPos(r.head, 1));
      const from = changes.mapPos(r.from, -1);
      const to = changes.mapPos(r.to, 1);
      return r.anchor <= r.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
    }),
    selection.mainIndex,
  );
}
