// Markdown 文档符号(标题)—— 转到符号(⇧⌘O / Quick Open `@`)与侧栏「大纲」视图的数据源。
// 对齐 VSCode markdown-language-features 的 documentSymbolProvider(vscode-markdown-languageservice
// tableOfContents + documentSymbols):
//   - 收集全文所有标题(复用锚点链接同一份源码解析 markdownHeadings:lezer,ATX / setext,含引用 / 列表项里的;代码块里的 `#`
//     不是标题;文首 frontmatter 抹成空白、行号不变;文字为渲染后的纯文本);空标题也收(与渲染出的标题节点按序号一一对应);
//   - 名称 = `'#'.repeat(级别) + ' ' + 纯文本`;
//   - 节范围:从标题行到下一个级别 ≤ 它的标题的前一行(没有则到文末);
//   - 嵌套:更深的标题挂到前面最近的更浅标题下。
// 本模块经 markdown-fragment 静态引入 lezer 解析器:调用方经 markdown-outline-model 的 markdownOutlineOf 动态加载,不进启动包。
// BDD: src/__tests__/markdown-outline/

import { markdownHeadings } from './markdown-fragment';
import { EMPTY_OUTLINE, type MarkdownOutline } from './markdown-outline-model';

interface MutableSymbol {
  name: string;
  text: string;
  level: number;
  line: number;
  endLine: number;
  ordinal: number;
  children: MutableSymbol[];
}

/** 源码的行数(\n / \r\n / \r 都算换行,同 CodeMirror;末尾换行后的空行也算)。 */
function lineCount(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) n++;
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      n++;
    }
  }
  return n;
}

/** 源码文本 → 标题符号(树 + 文档顺序)。 */
export function parseMarkdownSymbols(source: string): MarkdownOutline {
  if (!source.includes('#') && !source.includes('=') && !source.includes('-')) return EMPTY_OUTLINE;
  const flat: MutableSymbol[] = markdownHeadings(source, { keepEmpty: true }).map((h, ordinal) => {
    const text = h.text.replace(/\s+/g, ' ');
    return { name: `${'#'.repeat(h.level)} ${text}`, text, level: h.level, line: h.line, endLine: 0, ordinal, children: [] };
  });
  if (flat.length === 0) return EMPTY_OUTLINE;
  const lastLine = lineCount(source);
  const roots: MutableSymbol[] = [];
  const stack: MutableSymbol[] = [];
  for (const sym of flat) {
    // 出栈的(级别 ≥ 当前)节到当前标题的前一行结束;仍在栈里的到文末
    while (stack.length > 0 && stack[stack.length - 1]!.level >= sym.level) {
      const done = stack.pop()!;
      done.endLine = Math.max(done.line, sym.line - 1);
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(sym);
    else roots.push(sym);
    stack.push(sym);
  }
  for (const open of stack) open.endLine = lastLine;
  return { roots, flat };
}
