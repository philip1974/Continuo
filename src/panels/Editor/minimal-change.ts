// 两段文本之间的单段最小替换(去掉公共前后缀):外部重载 / 冲突合并 / 「不保存」关闭时以最小差异把文档换成另一版本(撤销粒度小、
// 光标随变化映射)。VSCode ModelService._computeEdits 同理(它按行 diff,这里取单段)。

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
