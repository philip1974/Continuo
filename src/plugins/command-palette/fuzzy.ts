// 命令面板模糊搜索(M-Plugin v1.6,纯函数)。
// 子序列匹配 + 词边界 / 连续匹配加分,大小写不敏感。

const EMPTY_FUZZY_RESULTS: readonly never[] = [];

function isBoundaryChar(ch: string): boolean {
  return ch === ' ' || ch === '.' || ch === '_' || ch === '-' || ch === '/';
}

/**
 * 内部打分:q 与 t **都必须已 lowercase**。空 q 返 0(子序列空集匹配)。
 * 性能 P16:把 target 的 lowercase 也抽出,让调用方可传预 lowercase 的 target
 * (Quick Open 每按键对 ≤5000 条稳定 relPath 重复 lowercasing 的来源)。
 */
function fuzzyScoreBothLower(q: string, t: string): number | null {
  if (q.length > t.length) return null;
  let qi = 0;
  let score = 0;
  let prevMatchedAt = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // 词边界加分:首字符 / 前一字符是空 . _ - /
      const isBoundary = ti === 0 || isBoundaryChar(t[ti - 1]!);
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

/**
 * q 必须**已 lowercase**(打磨 R51)。target 在此 lowercase。
 */
function fuzzyScoreLower(q: string, target: string): number | null {
  if (q.length > target.length) return null;
  return fuzzyScoreBothLower(q, target.toLowerCase());
}

export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  return fuzzyScoreLower(query.toLowerCase(), target);
}

export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getStr: (t: T) => string,
  /**
   * 性能 P16:可选——返回**已 lowercase** 的 target(scan 时预计算、跨按键稳定)。
   * 提供时跳过每 item 每按键的 `target.toLowerCase()`;打分语义与 getStr 路径逐字节一致。
   */
  getStrLower?: (t: T) => string,
): readonly T[] {
  if (items.length === 0) return items;
  if (!query) return items;
  const q = query.toLowerCase(); // 整批一次(打磨 R51),循环内复用
  if (items.length === 1) {
    const item = items[0]!;
    const score = getStrLower
      ? fuzzyScoreBothLower(q, getStrLower(item))
      : fuzzyScoreLower(q, getStr(item));
    return score === null ? EMPTY_FUZZY_RESULTS : items;
  }
  const matched = new Array<T>(items.length);
  const scores = new Array<number>(items.length);
  let count = 0;
  let prevScore = Infinity;
  let scoresSorted = true;
  for (const item of items) {
    const s = getStrLower
      ? fuzzyScoreBothLower(q, getStrLower(item))
      : fuzzyScoreLower(q, getStr(item));
    if (s !== null) {
      if (s > prevScore) scoresSorted = false;
      prevScore = s;
      matched[count] = item;
      scores[count] = s;
      count++;
    }
  }
  matched.length = count;
  scores.length = count;
  if (count === 0) return EMPTY_FUZZY_RESULTS;
  if (count < 2) return matched;
  if (scoresSorted) return matched;

  const order = new Array<number>(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => scores[b]! - scores[a]! || a - b);

  const result: T[] = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = matched[order[i]!]!;
  }
  return result;
}
