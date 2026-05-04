// 文本统计纯函数(StatusBar 用)。

export function lineCount(s: string): number {
  if (s.length === 0) return 0;
  // 尾部 \n 算下一行起点(空行)
  return (s.match(/\n/g)?.length ?? 0) + 1;
}

export function wordCount(s: string): number {
  const t = s.trim();
  if (t.length === 0) return 0;
  return t.split(/\s+/).length;
}

export function charCount(s: string): number {
  return s.length;
}
