// BDD: editor-goto-line 第 3 条 —— `:` 查询解析与夹取。见同目录 README。
import { describe, expect, it } from 'vitest';
import { clampGotoLine, isGotoLineQuery, parseGotoLineQuery } from '../../plugins/quick-open/goto-line';

const doc = (lengths: readonly number[]) => ({ lines: lengths.length, line: (n: number) => ({ length: lengths[n - 1]! }) });

describe('解析 `:` 查询', () => {
  it('以 `:` 开头才是转到行模式', () => {
    expect(isGotoLineQuery(':')).toBe(true);
    expect(isGotoLineQuery(':12')).toBe(true);
    expect(isGotoLineQuery('a:12')).toBe(false);
    expect(isGotoLineQuery('')).toBe(false);
  });

  it('`:N` / `:N:C`,也认 `N,C` / `N#C`,两侧空白忽略', () => {
    expect(parseGotoLineQuery(':300')).toEqual({ line: 300 });
    expect(parseGotoLineQuery(':12:5')).toEqual({ line: 12, column: 5 });
    expect(parseGotoLineQuery(':12,5')).toEqual({ line: 12, column: 5 });
    expect(parseGotoLineQuery(':12#5')).toEqual({ line: 12, column: 5 });
    expect(parseGotoLineQuery(':  7 ')).toEqual({ line: 7 });
    expect(parseGotoLineQuery(':-1')).toEqual({ line: -1 });
  });

  it('只有 `:` / 没有数字 / 行为 0 → null(不跳)', () => {
    expect(parseGotoLineQuery(':')).toBeNull();
    expect(parseGotoLineQuery(':abc')).toBeNull();
    expect(parseGotoLineQuery(':0')).toBeNull();
    expect(parseGotoLineQuery('12')).toBeNull();
  });
});

describe('夹到文档范围内', () => {
  const d = doc([10, 3, 0, 8]);
  it('越界行号 → 最后一行;负数从末尾数(-1 = 最后一行),过头夹到第 1 行', () => {
    expect(clampGotoLine({ line: 300 }, d)).toEqual({ line: 4 });
    expect(clampGotoLine({ line: -1 }, d)).toEqual({ line: 4 });
    expect(clampGotoLine({ line: -2 }, d)).toEqual({ line: 3 });
    expect(clampGotoLine({ line: -99 }, d)).toEqual({ line: 1 });
  });

  it('列超出行长 → 行尾(行长 + 1);列 < 1 视为未给', () => {
    expect(clampGotoLine({ line: 2, column: 99 }, d)).toEqual({ line: 2, column: 4 });
    expect(clampGotoLine({ line: 1, column: 5 }, d)).toEqual({ line: 1, column: 5 });
    expect(clampGotoLine({ line: 1, column: 0 }, d)).toEqual({ line: 1 });
    expect(clampGotoLine({ line: 1, column: -3 }, d)).toEqual({ line: 1 });
  });
});
