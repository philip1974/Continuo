// BDD: workspace-search / 4 预览行(VSCode Match.preview):命中前文按词边界截到约 26 字符并加「…」,命中尽量靠前可见;
// 无词边界的长前文按码点硬截;总长封顶;CJK / emoji 不拆代理对。main worker 与 renderer(已打开编辑器)共用 matchSearchText。
import { describe, expect, it } from 'vitest';
import {
  lcut,
  matchSearchText,
  SEARCH_PREVIEW_BEFORE_MAX,
  SEARCH_PREVIEW_LEAD,
  SEARCH_PREVIEW_MAX,
  type SearchMatch,
} from '../../../electron/shared/workspace-search';

const matches = (text: string, source: string): SearchMatch[] => matchSearchText(text, new RegExp(source, 'g'), 100).matches;
const hit = (m: SearchMatch) => m.preview.slice(m.previewStart, m.previewStart + m.previewLength);
const before = (m: SearchMatch) => m.preview.slice(0, m.previewStart);
/** 字符串里没有被拆开的代理对。 */
const wellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('lcut(照抄 VSCode strings.lcut)', () => {
  it('不足 n 个字符:只去前导空白', () => {
    expect(lcut('   short text ', 26, '…')).toBe('short text ');
  });
  it('在保留至少 n 个字符的最后一个词边界处截掉前文,加前缀', () => {
    const text = 'export function someVeryLongFunctionNameNumber0(argumentOne: string, ';
    const out = lcut(text, 26, '…');
    expect(out).toBe('…someVeryLongFunctionNameNumber0(argumentOne: string, ');
    expect(lcut('aaa bbb ccc ddd eee fff ggg hhh', 10, '…')).toBe('…fff ggg hhh');
  });
  it('找不到词边界:原样返回(去前导空白)', () => {
    expect(lcut('  中文中文中文中文中文中文中文中文中文中文中文中文中文中文', 5, '…')).toBe('中文中文中文中文中文中文中文中文中文中文中文中文中文中文');
  });
});

describe('预览行', () => {
  it('默认侧栏宽度的长行:命中前文按词边界截短,命中词紧随其后', () => {
    const line = 'export function someVeryLongFunctionNameNumber0(argumentOne: string, argumentTwo: number): void {}';
    const [m] = matches(line, 'argumentTwo');
    expect(hit(m!)).toBe('argumentTwo');
    expect(before(m!)).toBe('…someVeryLongFunctionNameNumber0(argumentOne: string, ');
    expect(m!.preview.endsWith('number): void {}')).toBe(true);
    expect(m!.column).toBe(line.indexOf('argumentTwo') + 1);
  });

  it('前文不长:只去行首空白,不加「…」', () => {
    const [m] = matches('\t  const x = foo();', 'foo');
    expect(m!.preview).toBe('const x = foo();');
    expect(hit(m!)).toBe('foo');
  });

  it('同一行多处命中:各自一条结果,各按自己的位置截前文', () => {
    const line = `${'word '.repeat(20)}hit ${'more '.repeat(20)}hit`;
    const [a, b] = matches(line, 'hit');
    expect(hit(a!)).toBe('hit');
    expect(hit(b!)).toBe('hit');
    expect(before(a!).length).toBeLessThanOrEqual(SEARCH_PREVIEW_LEAD + 6);
    expect(before(b!).startsWith('…more')).toBe(true);
  });

  it('长命中:命中截到总长上限内,previewLength 不越界', () => {
    const line = `prefix ${'z'.repeat(600)}`;
    const [m] = matches(line, 'z+');
    expect(m!.length).toBe(600);
    expect(m!.preview.length).toBeLessThanOrEqual(SEARCH_PREVIEW_MAX);
    expect(m!.previewStart + m!.previewLength).toBe(m!.preview.length);
  });

  it('无词边界的长前文(整行 CJK):按码点硬截到末 SEARCH_PREVIEW_LEAD 个字符并加「…」', () => {
    const line = `${'中文字'.repeat(80)}命中词`;
    const [m] = matches(line, '命中词');
    expect(before(m!)).toBe('…' + '中文字'.repeat(80).slice(-SEARCH_PREVIEW_LEAD));
    expect(hit(m!)).toBe('命中词');
  });

  it('不在码点中间截断:emoji 前文硬截、封顶处都不留半个代理对', () => {
    const emoji = '😀';
    const line = `${emoji.repeat(SEARCH_PREVIEW_BEFORE_MAX)}x${'😀'.repeat(400)}`;
    const [m] = matches(line, 'x');
    expect(wellFormed(m!.preview)).toBe(true);
    expect(hit(m!)).toBe('x');
    expect(m!.preview.length).toBeLessThanOrEqual(SEARCH_PREVIEW_MAX);
    // 奇数位置截前文
    const odd = `a${emoji.repeat(SEARCH_PREVIEW_BEFORE_MAX)}x`;
    const [n] = matches(odd, 'x');
    expect(wellFormed(n!.preview)).toBe(true);
    expect(hit(n!)).toBe('x');
  });
});
