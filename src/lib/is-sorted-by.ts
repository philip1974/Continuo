/**
 * 列表按 `compare` 是否已非降序。排序前先判一次,已有序就跳过排序 / 拷贝(命令面板、快捷键页、
 * Explorer 右键菜单分组共用;此前各手写一份相同循环)。
 */
export function isSortedBy<T>(
  items: readonly T[],
  compare: (a: T, b: T) => number,
): boolean {
  for (let i = 1; i < items.length; i++) {
    if (compare(items[i - 1]!, items[i]!) > 0) return false;
  }
  return true;
}
