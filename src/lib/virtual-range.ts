// 虚拟列表的渲染下标:在 @tanstack/react-virtual 默认窗口(可视 + overscan)之外常驻某一项。
// 用途:DOM 焦点所在行被滚出视口时不卸载 —— 否则焦点掉到 body,方向键 / 快捷键全部失效(VSCode 列表滚动不丢焦点)。
// 照 TanStack Virtual 官方 sticky 示例与 headless-tree 虚拟化示例:rangeExtractor 在默认窗口结果里并入该下标。
// 默认窗口按库的 defaultRangeExtractor 同式计算(单测逐项对照),不运行时 import 它:大量规范用固定导出列表
// vi.mock('@tanstack/react-virtual')(只给 useVirtualizer),import 未列出的导出会直接抛错。
import type { Range } from '@tanstack/react-virtual';

/** 同 defaultRangeExtractor:[max(start-overscan,0), min(end+overscan,count-1)] 连续升序。 */
function defaultIndexes(range: Range): number[] {
  const start = Math.max(range.startIndex - range.overscan, 0);
  const end = Math.min(range.endIndex + range.overscan, range.count - 1);
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

/** 渲染下标 = 默认窗口 ∪ {pinned}(升序、去重);pinned 越界(<0 或 ≥ count)时原样返回默认窗口。 */
export function rangeWithPinnedIndex(range: Range, pinned: number): number[] {
  const indexes = defaultIndexes(range);
  if (!Number.isInteger(pinned) || pinned < 0 || pinned >= range.count || indexes.includes(pinned)) return indexes;
  // 默认窗口是连续升序段:pinned 不在其中则必在两端之外
  return pinned < (indexes[0] ?? pinned + 1) ? [pinned, ...indexes] : [...indexes, pinned];
}
