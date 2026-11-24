/**
 * 两个数组逐元素相等(顺序敏感;同一引用直接 true)。`eq` 缺省为 `===`。
 * main 与 renderer 的「快照未变则跳过推送 / set」判断共用,不再各写一份长度 + 循环。
 */
const strictEq = (left: unknown, right: unknown): boolean => left === right;

export function arraysEqual<T>(
  a: readonly T[],
  b: readonly T[],
  eq: (left: T, right: T) => boolean = strictEq,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!eq(a[i]!, b[i]!)) return false;
  }
  return true;
}
