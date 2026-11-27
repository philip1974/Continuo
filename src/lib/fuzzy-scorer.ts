/*---------------------------------------------------------------------------------------------
 *  Ported from microsoft/vscode src/vs/base/common/fuzzyScorer.ts(scoreFuzzy / scoreItemFuzzy / compareItemsByFuzzyScore /
 *  prepareQuery)及其依赖的 filters.ts matchesPrefix、comparers.ts compareAnything / compareByPrefix
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://github.com/microsoft/vscode/blob/main/LICENSE.txt
 *--------------------------------------------------------------------------------------------*/
// Quick Open(⌘P)文件打分(VSCode anythingQuickAccess 同一套):先对文件名(label)打分 —— 前缀命中最高、短文件名优先、
// 连续命中加分;文件名不命中再对「目录 + 分隔符 + 文件名」打分。查询按空格拆段,每段都要命中(分数相加)。
// 与 VSCode 的差异:去掉跨按键的结果缓存(调用方每次全量排序);目标的小写形式可由调用方预先给出(性能 P16);
// 全路径等同判断用平台感知的 pathEquals;同分时调用方可加「最近打开」优先(compareItemScores 的 preferA / preferB)。
// BDD: src/__tests__/quick-open-fuzzy-score/

import { compareFileNames } from '../../electron/shared/compare-file-names';
import { pathEquals } from './path-cross';

export interface FuzzyMatch {
  readonly start: number;
  readonly end: number;
}

/** [分数, 命中下标];0 = 不命中。 */
export type FuzzyScore = [number, number[]];

const NO_MATCH = 0;
const NO_SCORE: FuzzyScore = [NO_MATCH, []];

const SLASH = 47;
const BACKSLASH = 92;

function isPathSeparator(code: number): boolean {
  return code === SLASH || code === BACKSLASH;
}

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

/**
 * 模糊打分(VSCode scoreFuzzy):query 的字符须按序出现在 target 里;分数按字符命中 / 连续命中 / 同大小写 / 词首 / 分隔符后 /
 * 驼峰大写累加,用矩阵取最高分那条匹配路径(而非贪心最左)。allowNonContiguousMatches=false 时只认连续子串。
 * targetLower:调用方预先算好的 target.toLowerCase()(缺省现算)。
 */
export function scoreFuzzy(
  target: string,
  query: string,
  queryLower: string,
  allowNonContiguousMatches: boolean,
  targetLower: string = target.toLowerCase(),
): FuzzyScore {
  if (!target || !query) return NO_SCORE;
  const targetLength = target.length;
  const queryLength = query.length;
  if (targetLength < queryLength) return NO_SCORE;

  // 快速排除:query 不是 target 的子序列(小写化改变长度时仍按 target.length 为界)
  if (!isSubsequence(queryLower, targetLower, targetLength)) return NO_SCORE;

  return doScoreFuzzy(query, queryLower, queryLength, target, targetLower, targetLength, allowNonContiguousMatches);
}

function isSubsequence(queryLower: string, targetLower: string, targetLength: number): boolean {
  const queryLength = queryLower.length;
  let queryIndex = 0;
  for (let targetIndex = 0; targetIndex < targetLength && queryIndex < queryLength; targetIndex++) {
    if (considerAsEqual(queryLower[queryIndex]!, targetLower[targetIndex])) queryIndex++;
  }
  return queryIndex === queryLength;
}

const MAX_CACHED_MATRIX_CELLS = 64 * 1024;
let cachedMatrix = { scores: new Int32Array(0), matches: new Int32Array(0) };

function getScoreMatrix(size: number): { scores: Int32Array | Float64Array; matches: Int32Array } {
  if (size > MAX_CACHED_MATRIX_CELLS) {
    // 不保留超大矩阵;很长的连续命中也可能超出 32 位分数
    return { scores: new Float64Array(size), matches: new Int32Array(size) };
  }
  if (cachedMatrix.scores.length < size) {
    cachedMatrix = { scores: new Int32Array(size), matches: new Int32Array(size) };
  }
  return cachedMatrix;
}

function doScoreFuzzy(
  query: string,
  queryLower: string,
  queryLength: number,
  target: string,
  targetLower: string,
  targetLength: number,
  allowNonContiguousMatches: boolean,
): FuzzyScore {
  const { scores, matches } = getScoreMatrix(queryLength * targetLength);

  // 打分矩阵:行 = query 字符、列 = target 字符;每格取「本格命中(对角 + 本字符分)」与「左格」的较大者,并记连续命中长度。
  for (let qi = 0; qi < queryLength; qi++) {
    const queryIndexOffset = qi * targetLength;
    const queryIndexPreviousOffset = queryIndexOffset - targetLength;
    const queryIndexGtNull = qi > 0;
    const queryCharAtIndex = query[qi]!;
    const queryLowerCode = queryLower.charCodeAt(qi);
    const queryIsPathSeparator = isPathSeparator(queryLowerCode);

    for (let ti = 0; ti < targetLength; ti++) {
      const targetIndexGtNull = ti > 0;
      const currentIndex = queryIndexOffset + ti;
      const leftIndex = currentIndex - 1;
      const diagIndex = queryIndexPreviousOffset + ti - 1;

      const leftScore = targetIndexGtNull ? scores[leftIndex]! : 0;
      scores[currentIndex] = leftScore;
      matches[currentIndex] = NO_MATCH;

      const targetLowerCode = targetLower.charCodeAt(ti);
      if (queryLowerCode !== targetLowerCode && !(queryIsPathSeparator && isPathSeparator(targetLowerCode))) continue;

      const diagScore = queryIndexGtNull && targetIndexGtNull ? scores[diagIndex]! : 0;
      if (queryIndexGtNull && !diagScore) continue; // 前面的 query 字符必须已经命中

      const matchesSequenceLength = queryIndexGtNull && targetIndexGtNull ? matches[diagIndex]! : 0;
      const score = diagScore + computeCharScore(queryCharAtIndex, target, ti, matchesSequenceLength);
      if (
        score >= leftScore &&
        // 只认连续命中时:第一个 query 字符须是整段 query 连续出现的起点
        (allowNonContiguousMatches || queryIndexGtNull || targetLower.startsWith(queryLower, ti))
      ) {
        matches[currentIndex] = matchesSequenceLength + 1;
        scores[currentIndex] = score;
      }
    }
  }

  // 从右下角回溯出命中下标
  const positions: number[] = [];
  let qi = queryLength - 1;
  let ti = targetLength - 1;
  while (qi >= 0 && ti >= 0) {
    const currentIndex = qi * targetLength + ti;
    if (matches[currentIndex] === NO_MATCH) {
      ti--;
    } else {
      positions.push(ti);
      qi--;
      ti--;
    }
  }
  return [scores[queryLength * targetLength - 1]!, positions.reverse()];
}

function computeCharScore(queryCharAtIndex: string, target: string, targetIndex: number, matchesSequenceLength: number): number {
  let score = 1; // 字符命中
  // 连续命中:前 3 个各 +6,其后各 +3(压低超长连续串的加成)
  if (matchesSequenceLength > 0) {
    score += Math.min(matchesSequenceLength, 3) * 6 + Math.max(0, matchesSequenceLength - 3) * 3;
  }
  if (queryCharAtIndex === target[targetIndex]) score += 1; // 同大小写
  if (targetIndex === 0) {
    score += 8; // 开头
  } else {
    const separatorBonus = scoreSeparatorAtPos(target.charCodeAt(targetIndex - 1));
    if (separatorBonus) {
      score += separatorBonus; // 分隔符之后
    } else if (isUpper(target.charCodeAt(targetIndex)) && matchesSequenceLength === 0) {
      score += 2; // 词内大写(驼峰),连续命中中不加:NPE → NullPointerException 加,HTTP → HTTP 不加
    }
  }
  return score;
}

function considerAsEqual(a: string, b: string | undefined): boolean {
  if (a === b) return true;
  // 路径分隔符不分平台
  if (a === '/' || a === '\\') return b === '/' || b === '\\';
  return false;
}

function scoreSeparatorAtPos(charCode: number): number {
  switch (charCode) {
    case SLASH:
    case BACKSLASH:
      return 5; // 路径分隔符优先……
    case 95: // _
    case 45: // -
    case 46: // .
    case 32: // 空格
    case 39: // '
    case 34: // "
    case 58: // :
      return 4; // ……其次其它分隔符
    default:
      return 0;
  }
}

// ── 查询预处理 ─────────────────────────────────────────────────────────────

export interface PreparedQueryPiece {
  readonly original: string;
  /** 去掉空白、通配符 `*`、引号、省略号 `…`、末尾 `#` 后的查询。 */
  readonly normalized: string;
  readonly normalizedLowercase: string;
  /** 两端带引号:只认连续子串(不模糊)。 */
  readonly expectContiguousMatch: boolean;
}

export interface PreparedQuery extends PreparedQueryPiece {
  /** 原样查询中的 `\` 换成 `/`(全路径等同判断用)。 */
  readonly pathNormalized: string;
  /** 按空格拆出的多段(只有一段时 undefined)。 */
  readonly values: readonly PreparedQueryPiece[] | undefined;
  /** 查询含路径分隔符:不再优先文件名,直接按「目录 / 文件名」打分。 */
  readonly containsPathSeparator: boolean;
}

function queryExpectsExactMatch(query: string): boolean {
  return query.startsWith('"') && query.endsWith('"');
}

function normalizeQuery(original: string): { pathNormalized: string; normalized: string; normalizedLowercase: string } {
  const pathNormalized = original.replace(/\\/g, '/');
  // 去掉:引号(精确匹配标记)、通配符、空白(多段分隔)、省略号(常用来表示任意路径段)、末尾 #(部分语言服务的查询修饰)
  const normalized = pathNormalized.replace(/[*…\s"]/g, '').replace(/(?<=.)#$/, '');
  return { pathNormalized, normalized, normalizedLowercase: normalized.toLowerCase() };
}

/** 查询预处理(VSCode prepareQuery):规范化,并按空格拆成多段(每段都要命中)。 */
export function prepareQuery(original: string): PreparedQuery {
  const { pathNormalized, normalized, normalizedLowercase } = normalizeQuery(original);
  const containsPathSeparator = pathNormalized.includes('/');
  let values: PreparedQueryPiece[] | undefined;
  const originalSplit = original.split(' ');
  if (originalSplit.length > 1) {
    for (const originalPiece of originalSplit) {
      const piece = normalizeQuery(originalPiece);
      if (!piece.normalized) continue;
      (values ??= []).push({
        original: originalPiece,
        normalized: piece.normalized,
        normalizedLowercase: piece.normalizedLowercase,
        expectContiguousMatch: queryExpectsExactMatch(originalPiece),
      });
    }
  }
  return {
    original,
    pathNormalized,
    normalized,
    normalizedLowercase,
    values,
    containsPathSeparator,
    expectContiguousMatch: queryExpectsExactMatch(original),
  };
}

// ── 条目(文件名 + 目录)打分 ─────────────────────────────────────────────────

export interface ItemScore {
  /** 总分(0 = 不命中)。 */
  readonly score: number;
  /** 文件名内的命中区段。 */
  readonly labelMatch?: readonly FuzzyMatch[];
  /** 目录内的命中区段。 */
  readonly descriptionMatch?: readonly FuzzyMatch[];
}

/** 打分的条目:文件名、所在目录(相对路径的目录部分,根下文件为空)、绝对路径;Lower 是预先小写化的形式。 */
export interface ScorableItem {
  readonly label: string;
  readonly labelLower: string;
  readonly description: string;
  /** description + 分隔符 + label(即相对路径)。 */
  readonly descriptionAndLabel: string;
  readonly descriptionAndLabelLower: string;
  readonly path: string;
}

const NO_ITEM_SCORE: ItemScore = Object.freeze({ score: 0 });

const PATH_IDENTITY_SCORE = 1 << 18;
const LABEL_PREFIX_SCORE_THRESHOLD = 1 << 17;
const LABEL_SCORE_THRESHOLD = 1 << 16;

/** 条目打分(VSCode scoreItemFuzzy):全路径一致 > 文件名前缀 > 文件名模糊 > 目录 + 文件名模糊;多段查询每段都要命中。 */
export function scoreItemFuzzy(item: ScorableItem, query: PreparedQuery, allowNonContiguousMatches: boolean): ItemScore {
  if (!query.normalized || !item.label) return NO_ITEM_SCORE;
  const preferLabelMatches = !query.containsPathSeparator;

  // 全路径一致最高
  if (pathEquals(query.pathNormalized, item.path)) {
    return {
      score: PATH_IDENTITY_SCORE,
      labelMatch: [{ start: 0, end: item.label.length }],
      ...(item.description ? { descriptionMatch: [{ start: 0, end: item.description.length }] } : {}),
    };
  }

  if (query.values && query.values.length > 1) {
    let totalScore = 0;
    const totalLabelMatches: FuzzyMatch[] = [];
    const totalDescriptionMatches: FuzzyMatch[] = [];
    for (const piece of query.values) {
      const { score, labelMatch, descriptionMatch } = scoreItemFuzzySingle(item, piece, preferLabelMatches, allowNonContiguousMatches);
      if (score === NO_MATCH) return NO_ITEM_SCORE; // 任一段不命中 → 整体不命中
      totalScore += score;
      if (labelMatch) totalLabelMatches.push(...labelMatch);
      if (descriptionMatch) totalDescriptionMatches.push(...descriptionMatch);
    }
    return {
      score: totalScore,
      labelMatch: normalizeMatches(totalLabelMatches),
      descriptionMatch: normalizeMatches(totalDescriptionMatches),
    };
  }

  return scoreItemFuzzySingle(item, query, preferLabelMatches, allowNonContiguousMatches);
}

function scoreItemFuzzySingle(
  item: ScorableItem,
  query: PreparedQueryPiece,
  preferLabelMatches: boolean,
  allowNonContiguousMatches: boolean,
): ItemScore {
  const { label, description } = item;
  // Continuo 性能:文件名是相对路径的后缀 —— 查询连「目录 + 文件名」的子序列都不是,两处打分都不会命中(数万候选里多数如此)
  if (
    description &&
    !isSubsequence(query.normalizedLowercase, item.descriptionAndLabelLower, item.descriptionAndLabel.length)
  ) {
    return NO_ITEM_SCORE;
  }
  if (preferLabelMatches || !description) {
    const [labelScore, labelPositions] = scoreFuzzy(
      label,
      query.normalized,
      query.normalizedLowercase,
      allowNonContiguousMatches && !query.expectContiguousMatch,
      item.labelLower,
    );
    if (labelScore) {
      // 文件名前缀命中:基础分大幅抬高(输入文件名开头即胜过文件名中间的命中),再按查询占文件名的比例加分
      //(查询 window:window.ts 胜过 windowActions.ts)
      const labelPrefixMatch = item.labelLower.startsWith(query.normalizedLowercase);
      const baseScore = labelPrefixMatch
        ? LABEL_PREFIX_SCORE_THRESHOLD + Math.round((query.normalized.length / label.length) * 100)
        : LABEL_SCORE_THRESHOLD;
      return {
        score: baseScore + labelScore,
        labelMatch: labelPrefixMatch ? [{ start: 0, end: query.normalized.length }] : createMatches(labelPositions),
      };
    }
  }

  if (description) {
    const descriptionPrefixLength = description.length + 1; // 目录 + 分隔符
    const [labelDescriptionScore, labelDescriptionPositions] = scoreFuzzy(
      item.descriptionAndLabel,
      query.normalized,
      query.normalizedLowercase,
      allowNonContiguousMatches && !query.expectContiguousMatch,
      item.descriptionAndLabelLower,
    );
    if (labelDescriptionScore) {
      const labelMatch: FuzzyMatch[] = [];
      const descriptionMatch: FuzzyMatch[] = [];
      // 命中区段拆回文件名 / 目录两部分
      for (const h of createMatches(labelDescriptionPositions)) {
        if (h.start < descriptionPrefixLength && h.end > descriptionPrefixLength) {
          labelMatch.push({ start: 0, end: h.end - descriptionPrefixLength });
          descriptionMatch.push({ start: h.start, end: descriptionPrefixLength });
        } else if (h.start >= descriptionPrefixLength) {
          labelMatch.push({ start: h.start - descriptionPrefixLength, end: h.end - descriptionPrefixLength });
        } else {
          descriptionMatch.push(h);
        }
      }
      return { score: labelDescriptionScore, labelMatch, descriptionMatch };
    }
  }
  return NO_ITEM_SCORE;
}

function createMatches(offsets: readonly number[]): FuzzyMatch[] {
  const ret: { start: number; end: number }[] = [];
  let last: { start: number; end: number } | undefined;
  for (const pos of offsets) {
    if (last && last.end === pos) {
      last.end += 1;
    } else {
      last = { start: pos, end: pos + 1 };
      ret.push(last);
    }
  }
  return ret;
}

/** 区段按起点排序并合并重叠 / 相接的。 */
function normalizeMatches(matches: readonly FuzzyMatch[]): FuzzyMatch[] {
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  let current: { start: number; end: number } | undefined;
  for (const m of sorted) {
    if (!current || current.end < m.start) {
      current = { start: m.start, end: m.end };
      out.push(current);
    } else {
      current.end = Math.max(current.end, m.end);
    }
  }
  return out;
}

// ── 排序 ─────────────────────────────────────────────────────────────────

/**
 * 比较两个已打分条目(VSCode compareItemScores;<0 = a 在前)。preferA / preferB:分数相同时优先的一方(Quick Open 的「最近打开」)。
 */
export function compareItemScores(
  itemA: ScorableItem,
  itemB: ScorableItem,
  scoreA: ItemScore,
  scoreB: ItemScore,
  query: PreparedQuery,
  preferA = false,
  preferB = false,
): number {
  const a = scoreA.score;
  const b = scoreB.score;

  // 1. 全路径一致最高
  if ((a === PATH_IDENTITY_SCORE || b === PATH_IDENTITY_SCORE) && a !== b) return a === PATH_IDENTITY_SCORE ? -1 : 1;

  // Continuo:同分时「最近打开」优先
  if (a === b && preferA !== preferB) return preferA ? -1 : 1;

  // 2. 文件名命中高于「目录 + 文件名」命中
  if (a > LABEL_SCORE_THRESHOLD || b > LABEL_SCORE_THRESHOLD) {
    if (a !== b) return a > b ? -1 : 1;
    // 非前缀命中时:文件名内命中越紧凑越好
    if (a < LABEL_PREFIX_SCORE_THRESHOLD && b < LABEL_PREFIX_SCORE_THRESHOLD) {
      const byLength = compareByMatchLength(scoreA.labelMatch, scoreB.labelMatch);
      if (byLength !== 0) return byLength;
    }
    // 短文件名优先
    if (itemA.label.length !== itemB.label.length) return itemA.label.length - itemB.label.length;
  }

  // 3. 「目录 + 文件名」分数
  if (a !== b) return a > b ? -1 : 1;

  // 4. 同分:文件名里有命中的优先
  const aHasLabel = (scoreA.labelMatch?.length ?? 0) > 0;
  const bHasLabel = (scoreB.labelMatch?.length ?? 0) > 0;
  if (aHasLabel && !bHasLabel) return -1;
  if (bHasLabel && !aHasLabel) return 1;

  // 5. 同分:命中跨度更紧凑的优先
  const aDistance = computeLabelAndDescriptionMatchDistance(itemA, scoreA);
  const bDistance = computeLabelAndDescriptionMatchDistance(itemB, scoreB);
  if (aDistance && bDistance && aDistance !== bDistance) return bDistance > aDistance ? -1 : 1;

  // 6. 兜底
  return fallbackCompare(itemA, itemB, query);
}

function computeLabelAndDescriptionMatchDistance(item: ScorableItem, score: ItemScore): number {
  let matchStart = -1;
  let matchEnd = -1;
  if (score.descriptionMatch?.length) matchStart = score.descriptionMatch[0]!.start;
  else if (score.labelMatch?.length) matchStart = score.labelMatch[0]!.start;
  if (score.labelMatch?.length) {
    matchEnd = score.labelMatch[score.labelMatch.length - 1]!.end;
    if (score.descriptionMatch?.length && item.description) matchEnd += item.description.length;
  } else if (score.descriptionMatch?.length) {
    matchEnd = score.descriptionMatch[score.descriptionMatch.length - 1]!.end;
  }
  return matchEnd - matchStart;
}

function compareByMatchLength(matchesA?: readonly FuzzyMatch[], matchesB?: readonly FuzzyMatch[]): number {
  if (!matchesA?.length && !matchesB?.length) return 0;
  if (!matchesB?.length) return -1;
  if (!matchesA?.length) return 1;
  const lengthA = matchesA[matchesA.length - 1]!.end - matchesA[0]!.start;
  const lengthB = matchesB[matchesB.length - 1]!.end - matchesB[0]!.start;
  return lengthA === lengthB ? 0 : lengthB < lengthA ? 1 : -1;
}

function fallbackCompare(itemA: ScorableItem, itemB: ScorableItem, query: PreparedQuery): number {
  // 文件名 + 目录更短的优先
  const lengthA = itemA.label.length + itemA.description.length;
  const lengthB = itemB.label.length + itemB.description.length;
  if (lengthA !== lengthB) return lengthA - lengthB;
  if (itemA.path.length !== itemB.path.length) return itemA.path.length - itemB.path.length;
  // 比较用预先小写化的形式(排序热路径,不逐次 toLowerCase)
  if (itemA.label !== itemB.label) return compareAnything(itemA.labelLower, itemB.labelLower, query.normalizedLowercase);
  if (itemA.description && itemB.description && itemA.description !== itemB.description) {
    return compareAnything(
      itemA.descriptionAndLabelLower.slice(0, itemA.description.length),
      itemB.descriptionAndLabelLower.slice(0, itemB.description.length),
      query.normalizedLowercase,
    );
  }
  if (itemA.path !== itemB.path) return compareAnything(itemA.path.toLowerCase(), itemB.path.toLowerCase(), query.normalizedLowercase);
  return 0;
}

/** a / b 须已小写(VSCode compareAnything 内部先 toLowerCase)。 */
function compareAnything(a: string, b: string, lookFor: string): number {
  // 前缀命中优先;同为前缀命中时短的优先
  const aPrefix = a.startsWith(lookFor);
  const bPrefix = b.startsWith(lookFor);
  if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
  if (aPrefix && bPrefix && a.length !== b.length) return a.length < b.length ? -1 : 1;
  // 后缀命中优先
  const aSuffix = a.endsWith(lookFor);
  const bSuffix = b.endsWith(lookFor);
  if (aSuffix !== bSuffix) return aSuffix ? -1 : 1;
  const r = compareFileNames(a, b);
  if (r !== 0) return r;
  return a.localeCompare(b);
}

/** 区段 → 逐字符下标(列表行高亮用)。 */
export function matchesToIndices(matches: readonly FuzzyMatch[] | undefined): number[] | null {
  if (!matches || matches.length === 0) return null;
  const out: number[] = [];
  for (const m of matches) for (let i = m.start; i < m.end; i++) out.push(i);
  return out;
}
