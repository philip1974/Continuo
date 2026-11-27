// 文件名排序比较器(资源管理器 / listDir 输出顺序的单一来源)。
//
// 对齐 VSCode `explorer.sortOrderLexicographicOptions: default` 的 compareFileNamesDefault(src/vs/base/common/comparers.ts):
// `Intl.Collator(undefined, { numeric: true })` —— 数字段按数值比(file-2 < file-10)、大小写混排(同名仅大小写不同时按
// 区域规则次序)、点文件不特殊处理(`.` 是标点,按 collator 自然排在字母前);numeric 让 `foo1` 与 `foo01` 相等时短的在前。
// 末级按 UTF-16 码元兜底,保证全序(canonical 等价的 NFC / NFD 同名等仍有确定次序)。

const collator = new Intl.Collator(undefined, { numeric: true });

export function compareFileNames(a: string, b: string): number {
  const r = collator.compare(a, b);
  if (r !== 0) return r;
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}
