// BDD: markdown-outline 第 1 条 —— Markdown 标题符号解析(ATX / setext、嵌套、节范围、纯文本名称、忽略代码块与 frontmatter)。见同目录 README。
import { describe, expect, it } from 'vitest';
import { parseMarkdownSymbols } from '@/panels/Editor/markdown-symbols';
import { markdownHeadings } from '@/panels/Editor/markdown-fragment';
import { symbolOrdinalAtLine, type MarkdownSymbol } from '@/panels/Editor/markdown-outline-model';

/** 树 → [名称, 行, 节末行, 子树] 便于比较。 */
type Shape = [string, number, number, Shape[]?];
function shape(symbols: readonly MarkdownSymbol[]): Shape[] {
  return symbols.map((s) => (s.children.length ? [s.name, s.line, s.endLine, shape(s.children)] : [s.name, s.line, s.endLine]));
}

describe('标题符号', () => {
  it('ATX 与 setext 标题按级别嵌套;名称 = `#` × 级别 + 空格 + 文字(VSCode 同);节到下一个同级或更浅标题之前', () => {
    const src = [
      '# Title', //           1
      '', //                  2
      'intro', //             3
      '## A', //              4
      'text', //              5
      '### A.1 ###', //       6
      'Setext two', //        7
      '----------', //        8
      'B section', //         9
      '=========', //         10
      '#### deep', //         11
    ].join('\n');
    const { roots, flat } = parseMarkdownSymbols(src);
    expect(shape(roots)).toEqual([
      ['# Title', 1, 8, [['## A', 4, 6, [['### A.1', 6, 6]]], ['## Setext two', 7, 8]]],
      ['# B section', 9, 11, [['#### deep', 11, 11]]],
    ]);
    expect(flat.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(flat.map((s) => s.level)).toEqual([1, 2, 3, 2, 1, 4]);
  });

  it('围栏 / 缩进代码块里的 `#`、文首 YAML frontmatter(其 `---` 不当 setext)都不是标题;行号仍按原文', () => {
    const src = [
      '---', //               1
      'title: x', //          2
      '---', //               3
      '```sh', //             4
      '# not a heading', //   5
      '```', //               6
      '', //                  7
      '    # indented code', // 8
      '', //                  9
      '# Real', //            10
    ].join('\n');
    expect(shape(parseMarkdownSymbols(src).roots)).toEqual([['# Real', 10, 10]]);
  });

  it('引用 / 列表项里的标题也收集(VSCode 按全部 heading token)', () => {
    const src = '> # Quoted\n\n- ## In list\n';
    expect(parseMarkdownSymbols(src).flat.map((s) => s.name)).toEqual(['# Quoted', '## In list']);
  });

  it('名称是渲染后的纯文本(与锚点链接同一份解析):去掉强调 / 行内代码反引号 / 链接地址 / 转义;图片不计文字', () => {
    const src = '# **Bold** and `code` [link](http://x.y "t") ![alt](a.png) \\# esc ~~del~~\n';
    expect(parseMarkdownSymbols(src).flat[0]!.text).toBe('Bold and code link # esc del');
  });

  it('空标题也收(与编辑 / 预览视图里的标题节点按序号对应),名称只有 `#`', () => {
    const { flat } = parseMarkdownSymbols('# A\n\n##\n\n## B\n');
    expect(flat.map((s) => [s.name, s.ordinal])).toEqual([
      ['# A', 0],
      ['## ', 1],
      ['## B', 2],
    ]);
    // 锚点链接的标题列表照旧不收空标题(标记不算文字)
    expect(markdownHeadings('# A\n\n##\n\n## B\n').map((h) => h.text)).toEqual(['A', 'B']);
  });

  it('CRLF 换行同样按行计;没有标题 → 空', () => {
    // 末尾换行后的空行也算一行(VSCode lineCount 同)
    expect(shape(parseMarkdownSymbols('x\r\n\r\n## Two\r\nbody\r\n').roots)).toEqual([['## Two', 3, 5]]);
    expect(parseMarkdownSymbols('plain text only\n- item\n').flat).toEqual([]);
    expect(parseMarkdownSymbols('').flat).toEqual([]);
  });

  it('某行所在的节 = 不晚于该行的最后一个标题;第一个标题之前 → -1', () => {
    const outline = parseMarkdownSymbols('pre\n# A\na\n## B\nb\n# C\n');
    expect(symbolOrdinalAtLine(outline, 1)).toBe(-1);
    expect(symbolOrdinalAtLine(outline, 2)).toBe(0);
    expect(symbolOrdinalAtLine(outline, 3)).toBe(0);
    expect(symbolOrdinalAtLine(outline, 5)).toBe(1);
    expect(symbolOrdinalAtLine(outline, 99)).toBe(2);
  });

  it('大文档(1 万行、1000 个标题)解析在百毫秒量级内', () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(`${'#'.repeat((i % 3) + 1)} Heading ${i}`, '', 'Some *text* with `code` and [link](x).', '', '```js', 'const a = 1; // # no', '```', '', '- item', '');
    }
    const src = lines.join('\n');
    const t0 = performance.now();
    const outline = parseMarkdownSymbols(src);
    const ms = performance.now() - t0;
    expect(outline.flat).toHaveLength(1000);
    expect(ms).toBeLessThan(500);
  });
});
