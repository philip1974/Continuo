import { describe, it, expect } from 'vitest';
import {
  charCount,
  lineCount,
  wordCount,
} from '../../lib/text-stats';

describe('lineCount', () => {
  it('空串 → 0', () => {
    expect(lineCount('')).toBe(0);
  });
  it('单行无换行 → 1', () => {
    expect(lineCount('hello')).toBe(1);
  });
  it('两行 → 2', () => {
    expect(lineCount('a\nb')).toBe(2);
  });
  it('尾部 \\n → 算下一空行', () => {
    expect(lineCount('a\n')).toBe(2);
  });
  it('Windows CRLF 也算 1 行分隔(只看 \\n)', () => {
    expect(lineCount('a\r\nb')).toBe(2);
  });
});

describe('wordCount', () => {
  it('空串 → 0', () => {
    expect(wordCount('')).toBe(0);
  });
  it('全空白 → 0', () => {
    expect(wordCount('   \n\t')).toBe(0);
  });
  it('单词 → 词数', () => {
    expect(wordCount('hello world')).toBe(2);
    expect(wordCount('a b c d e')).toBe(5);
  });
  it('多空格 / 制表符 / 换行混合 → 按 \\s+ 切', () => {
    expect(wordCount('a  b\tc\nd')).toBe(4);
  });
  it('首尾空白不算', () => {
    expect(wordCount('  hello  ')).toBe(1);
  });
});

describe('charCount', () => {
  it('空 → 0', () => {
    expect(charCount('')).toBe(0);
  });
  it('返字符串长度', () => {
    expect(charCount('hello')).toBe(5);
    expect(charCount('a\nb')).toBe(3);
  });
});
