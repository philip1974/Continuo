// Quick Open 过滤排序(VSCode anythingQuickAccess:prepareQuery + scoreItemFuzzy + compareItemsByFuzzyScore,见 src/lib/fuzzy-scorer)。
// 文件名(label)优先打分、目录为 description;查询按空格拆段每段都要命中;同分时「最近打开」在前(Continuo 既有加权)。
// BDD: src/__tests__/quick-open-fuzzy-score/

import { compareItemScores, prepareQuery, scoreItemFuzzy, type ItemScore, type ScorableItem } from '@/lib/fuzzy-scorer';
import type { QuickOpenFile } from './store';

export interface QuickOpenFilterResult {
  readonly files: readonly QuickOpenFile[];
  /** 各结果的命中区段(文件名 / 目录,列表行高亮用);空查询时为空。 */
  readonly scores: ReadonlyMap<QuickOpenFile, ItemScore>;
}

const NO_SCORES: ReadonlyMap<QuickOpenFile, ItemScore> = new Map();

/** 有查询时最多列出的结果数(VSCode AnythingQuickAccessProvider.MAX_RESULTS):只取分数最高的这些,免对数万条全排序。 */
export const QUICK_OPEN_MAX_RESULTS = 512;

// 打分用的派生字段(文件名小写、目录、全路径 `/` 分隔)按扫描结果对象缓存:同一次扫描内跨按键稳定(性能 P16 同思路)。
const scorables = new WeakMap<QuickOpenFile, ScorableItem>();

function scorableOf(f: QuickOpenFile): ScorableItem {
  let s = scorables.get(f);
  if (s === undefined) {
    const nameStart = f.relPath.length - f.name.length;
    s = {
      label: f.name,
      labelLower: f.relPathLower.slice(nameStart),
      description: nameStart > 0 ? f.relPath.slice(0, nameStart - 1) : '',
      descriptionAndLabel: f.relPath,
      descriptionAndLabelLower: f.relPathLower,
      path: f.absPath.replace(/\\/g, '/'),
    };
    scorables.set(f, s);
  }
  return s;
}

/**
 * items:已按「最近打开」排好的候选(前 recentCount 个是最近打开);query:规范化后的查询(空 → 原样返回)。
 */
export function filterQuickOpenFiles(
  items: readonly QuickOpenFile[],
  recentCount: number,
  query: string,
): QuickOpenFilterResult {
  if (!query) return { files: items, scores: NO_SCORES };
  const prepared = prepareQuery(query);
  if (!prepared.normalized) return { files: items, scores: NO_SCORES };
  const hits: { file: QuickOpenFile; item: ScorableItem; score: ItemScore; recent: boolean }[] = [];
  for (let i = 0; i < items.length; i++) {
    const file = items[i]!;
    const item = scorableOf(file);
    const score = scoreItemFuzzy(item, prepared, true);
    if (score.score) hits.push({ file, item, score, recent: i < recentCount });
  }
  const best = top(
    hits,
    (a, b) => compareItemScores(a.item, b.item, a.score, b.score, prepared, a.recent, b.recent),
    QUICK_OPEN_MAX_RESULTS,
  );
  const files = new Array<QuickOpenFile>(best.length);
  const scores = new Map<QuickOpenFile, ItemScore>();
  for (let i = 0; i < best.length; i++) {
    const h = best[i]!;
    files[i] = h.file;
    scores.set(h.file, h.score);
  }
  return { files, scores };
}

/** 按 compare 排序后的前 n 个(VSCode arrays.top:先排前 n 个,其余逐个与第 n 名比较、更好的二分插入)。 */
function top<T>(array: readonly T[], compare: (a: T, b: T) => number, n: number): T[] {
  const result = array.slice(0, n).sort(compare);
  if (result.length < n) return result;
  for (let i = n; i < array.length; i++) {
    const element = array[i]!;
    if (compare(element, result[n - 1]!) >= 0) continue;
    result.pop();
    let lo = 0;
    let hi = result.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(element, result[mid]!) < 0) hi = mid;
      else lo = mid + 1;
    }
    result.splice(lo, 0, element);
  }
  return result;
}
