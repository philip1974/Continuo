// 命令面板模糊搜索(M-Plugin v1.6,纯函数)。
// 子序列匹配 + 词边界 / 连续匹配加分,大小写不敏感。

const BOUNDARY_RE = /[ ._\-/]/;

export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatchedAt = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // 词边界加分:首字符 / 前一字符是空 . _ - /
      const isBoundary = ti === 0 || BOUNDARY_RE.test(t[ti - 1]!);
      score += isBoundary ? 10 : 1;
      // 连续匹配加分
      if (prevMatchedAt === ti - 1) score += 5;
      prevMatchedAt = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  return score;
}

export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getStr: (t: T) => string,
): T[] {
  if (!query) return [...items];
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const s = fuzzyScore(query, getStr(item));
    if (s !== null) scored.push({ item, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.item);
}
