// Markdown 数学公式:编辑 / 预览模式(Milkdown / Crepe 的 Latex 特性)的识别规则、KaTeX 渲染与原样往返。
// BDD: src/__tests__/markdown-math/
//
// 识别规则(编辑 / 预览同一个 remark 解析器,故只有这一套):remark-math(`$…$` 行内、`$$…$$` 行内或成块)+ Pandoc 规则 ——
// 单个 `$` 开头后面不是空白,结尾前面不是空白 / 反斜杠、后面不是数字;不满足的 `$` 是普通字符,解析继续(`$5 and $10`
// 是文字,`$5 *and* $10` 里的强调照常生效)。Crepe 自带的 Pandoc 守卫在解析之后把不合规的配对整段改回原文,会吞掉中间的
// 强调 / 链接,这里改在分词阶段判定(替换 remark-math 的行内分词器),守卫随之不再触发。`$$` 不受 Pandoc 限制。
// 不支持 `\(…\)` / `\[…\]`(VSCode 同样不支持)。
//
// 原样往返(编辑公式之外的内容,公式字节不变;编辑公式后输出规范写法):
//  - 行内公式记下源码原文(attrs.raw),公式值未变就原样写回(`$$x$$`、`$$ x $$` 不被改成 `$x$`)。
//  - 公式块记下 `$` 围栏长度、开栏行的 meta、是否闭合;```latex / ```math 围栏仍是代码块(Crepe 默认会把所有 latex 代码块
//    写成 `$$`)。
//  - 文字里的 `$`:只在去掉转义也不会形成新公式 / 拆散已有公式时才不转义(按同一解析器试解析该段的 `$` 结构判定),
//    `$5 and $10` 原样保留;否则一律转义(Milkdown 的 text 处理器对「以空白结尾」的文字会跳过转义,这里补上)。

import type { Crepe } from '@milkdown/crepe';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { codeBlockConfig } from '@milkdown/kit/component/code-block';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import { $nodeSchema, $remark } from '@milkdown/kit/utils';
import { renderMathInto, renderMathPreview } from './katex-render';

export const MATH_INLINE_ID = 'math_inline';

// ---------------------------------------------------------------------------------------------------------------------
// 分词:remark-math 的行内公式 + Pandoc 规则

/** micromark 字符码:null = 文末,负数 = 制表符 / 虚拟空格 / 换行。 */
type Code = number | null;
interface Effects {
  enter(type: string): { type: string };
  exit(type: string): unknown;
  consume(code: Code): void;
}
type State = (code: Code) => State | undefined;
interface Construct {
  name?: string;
  tokenize: (this: unknown, effects: Effects, ok: State, nok: State) => State;
  [key: string]: unknown;
}

const DOLLAR = 36;
const BACKSLASH = 92;
function isWhitespace(code: Code): boolean {
  return code === null || code < 0 || code === 32;
}
function isLineEnding(code: Code): boolean {
  return code === -5 || code === -4 || code === -3;
}
function isDigit(code: Code): boolean {
  return code !== null && code >= 48 && code <= 57;
}

/**
 * micromark-extension-math 的 tokenizeMathText,加 Pandoc 规则(只对单个 `$`):开头 `$` 后是空白 → 不是公式;
 * 候选结尾 `$` 前是空白 / 反斜杠或后面是数字 → 当作公式内的普通字符继续找。找不到结尾 → 开头 `$` 是普通字符。
 */
function tokenizePandocMathText(effects: Effects, ok: State, nok: State): State {
  let sizeOpen = 0;
  let size = 0;
  let token: { type: string } | null = null;
  let last: Code = null;
  let closerPrev: Code = null;

  const sequenceOpen: State = (code) => {
    if (code === DOLLAR) {
      effects.consume(code);
      sizeOpen += 1;
      return sequenceOpen;
    }
    if (sizeOpen === 1 && isWhitespace(code)) return nok(code);
    effects.exit('mathTextSequence');
    return between(code);
  };
  const between: State = (code) => {
    if (code === null) return nok(code);
    if (code === DOLLAR) {
      closerPrev = last;
      token = effects.enter('mathTextSequence');
      size = 0;
      return sequenceClose(code);
    }
    if (code === 32) {
      effects.enter('space');
      effects.consume(code);
      effects.exit('space');
      last = code;
      return between;
    }
    if (isLineEnding(code)) {
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      last = code;
      return between;
    }
    effects.enter('mathTextData');
    return data(code);
  };
  const data: State = (code) => {
    if (code === null || code === 32 || code === DOLLAR || isLineEnding(code)) {
      effects.exit('mathTextData');
      return between(code);
    }
    effects.consume(code);
    last = code;
    return data;
  };
  const sequenceClose: State = (code) => {
    if (code === DOLLAR) {
      effects.consume(code);
      size += 1;
      return sequenceClose;
    }
    const pandocReject = sizeOpen === 1 && (isWhitespace(closerPrev) || closerPrev === BACKSLASH || isDigit(code));
    if (size === sizeOpen && !pandocReject) {
      effects.exit('mathTextSequence');
      effects.exit('mathText');
      return ok(code);
    }
    // 长度不同或不合 Pandoc 规则:这串 `$` 是公式内容
    token!.type = 'mathTextData';
    last = DOLLAR;
    return data(code);
  };
  return (code) => {
    effects.enter('mathText');
    effects.enter('mathTextSequence');
    return sequenceOpen(code);
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// mdast:记原文 / 围栏信息;序列化时按原文写回

interface MdNode {
  type: string;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  url?: string;
  title?: string | null;
  alt?: string | null;
  data?: Record<string, unknown>;
  children?: MdNode[];
}

/** `$$` 公式块的源码信息(code_block 的 attrs.math)。 */
// type(而非 interface):作为 ProseMirror attrs / mdast data 需满足 JSON 记录类型
export type MathBlockInfo = {
  /** 开栏 `$` 个数。 */
  readonly fence: number;
  /** 开栏行 `$$` 之后的文字(公式块不显示它,原样保留)。 */
  readonly meta: string | null;
  /** 有闭栏(没有 = 公式块延伸到容器末尾,写回时也不补闭栏)。 */
  readonly closed: boolean;
  /** 开栏行原文(meta 前后的空白、`$$` 后的尾随空格原样写回)。 */
  readonly opening: string;
};

/** 行内公式原文对应的值(与 mdast-util-math 解析一致:去掉等长的 `$` 串,两端都是空格 / 换行且有内容时各去一个)。 */
export function inlineMathValueFromRaw(raw: string): string | null {
  const m = /^\$+/.exec(raw);
  if (!m) return null;
  const n = m[0].length;
  if (raw.length < 2 * n || raw.slice(raw.length - n) !== m[0]) return null;
  let inner = raw.slice(n, raw.length - n);
  if (/[^ \r\n]/.test(inner) && /^[ \r\n]/.test(inner) && /[ \r\n]$/.test(inner)) inner = inner.slice(1, -1);
  return inner;
}

/** 规范写法(mdast-util-math 的 inlineMath 处理器,不含跨行的块结构规避)。 */
export function canonicalInlineMath(value: string): string {
  let size = 1;
  while (new RegExp(`(^|[^$])${'\\$'.repeat(size)}([^$]|$)`).test(value)) size += 1;
  const seq = '$'.repeat(size);
  const padded =
    /[^ \r\n]/.test(value) && ((/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value)) || /^\$|\$$/.test(value))
      ? ` ${value} `
      : value;
  return seq + padded + seq;
}

function inlineMathMarkdown(node: MdNode): string | null {
  const raw = node.data?.continuoRaw;
  return typeof raw === 'string' && inlineMathValueFromRaw(raw) === (node.value ?? '') ? raw : null;
}

function mathBlockInfoFromRaw(raw: string, meta: string | null): MathBlockInfo {
  const fence = /^\$*/.exec(raw)![0].length;
  const lines = raw.split(/\r\n|\n|\r/);
  const lastLine = lines[lines.length - 1]!.replace(/^[ \t>]*/, '');
  const closed = lines.length > 1 && new RegExp(`^\\\${${fence},}[ \\t]*$`).test(lastLine);
  return { fence, meta, closed, opening: lines[0]! };
}

type Handler = (node: MdNode, parent: unknown, state: unknown, info: unknown) => string;
interface CompileContext {
  stack: MdNode[];
  sliceSerialize(token: unknown): string;
}
type ExitHandler = (this: CompileContext, token: unknown) => void;
interface FromMarkdownExt {
  exit?: Record<string, ExitHandler>;
}
interface ToMarkdownExt {
  handlers?: Record<string, Handler>;
}
interface SyntaxExt {
  text?: Record<number, Construct>;
}
interface ProcessorLike {
  data(): Record<string, unknown>;
  parse(doc: string): MdNode;
  compiler?: (tree: MdNode, file: unknown) => string;
}

const PATCHED = Symbol('continuoMath');

function patchOnce<T extends object>(obj: T): boolean {
  const o = obj as T & { [PATCHED]?: true };
  if (o[PATCHED]) return false;
  o[PATCHED] = true;
  return true;
}

/** remark 插件(排在 Crepe 的 remark-math 之后):替换行内分词器、记原文、按原文序列化、决定文字里 `$` 的转义。 */
const continuoMathRemark = $remark('continuoMath', () => function continuoMath(this: unknown) {
  const self = this as ProcessorLike;
  const data = self.data();
  for (const ext of (data.micromarkExtensions as SyntaxExt[] | undefined) ?? []) {
    const construct = ext.text?.[DOLLAR];
    if (construct?.name === 'mathText' && patchOnce(ext)) {
      ext.text![DOLLAR] = { ...construct, tokenize: tokenizePandocMathText as Construct['tokenize'] };
    }
  }
  for (const ext of (data.fromMarkdownExtensions as FromMarkdownExt[] | undefined) ?? []) {
    const exit = ext.exit;
    if (!exit?.mathText || !exit.mathFlow || !patchOnce(ext)) continue;
    const exitText = exit.mathText;
    const exitFlow = exit.mathFlow;
    // 原处理器先 resume() 弹出缓冲、再 exit 公式节点:之后栈顶是父节点,公式是其最后一个子节点
    const justExited = (ctx: CompileContext): MdNode | undefined => ctx.stack[ctx.stack.length - 1]?.children?.at(-1);
    exit.mathText = function (token) {
      exitText.call(this, token);
      const node = justExited(this);
      if (node?.type === 'inlineMath') node.data = { ...node.data, continuoRaw: this.sliceSerialize(token) };
    };
    // 公式块直接成为 language=LaTeX 的代码块(Crepe 的转换会丢掉位置与围栏信息),附上源码信息
    exit.mathFlow = function (token) {
      exitFlow.call(this, token);
      const node = justExited(this);
      if (node?.type !== 'math') return;
      const info = mathBlockInfoFromRaw(this.sliceSerialize(token), node.meta ?? null);
      node.type = 'code';
      node.lang = 'LaTeX';
      node.meta = null;
      node.data = { continuoMath: info };
    };
  }
  for (const ext of (data.toMarkdownExtensions as ToMarkdownExt[] | undefined) ?? []) {
    const handlers = ext.handlers;
    if (!handlers?.inlineMath || !handlers.math || !patchOnce(ext)) continue;
    const inline = handlers.inlineMath;
    const flow = handlers.math;
    handlers.inlineMath = (node, parent, state, info) => inlineMathMarkdown(node) ?? inline(node, parent, state, info);
    handlers.math = (node, parent, state, info) => {
      let out = flow(node, parent, state, info);
      const m = node.data?.continuoMath as MathBlockInfo | undefined;
      if (!m) return out;
      let seq = /^\$+/.exec(out)![0];
      // 原围栏更长(内容里的 `$` 串不需要这么长)→ 沿用原长度
      if (m.fence > seq.length) {
        const longer = '$'.repeat(m.fence);
        out = longer + out.slice(seq.length, out.length - seq.length) + longer;
        seq = longer;
      }
      // 开栏行:同长度围栏、meta 未变 → 原样
      const nl = out.indexOf('\n');
      if (
        nl > 0 &&
        /^\$*/.exec(m.opening)![0].length === seq.length &&
        m.opening.slice(seq.length).trim() === (node.meta ?? '')
      ) {
        out = m.opening + out.slice(nl);
      }
      return m.closed || !out.endsWith(`\n${seq}`) ? out : out.slice(0, -(seq.length + 1));
    };
  }
  const compile = self.compiler;
  if (compile) {
    self.compiler = (tree, file) => {
      markDollarText(tree, (doc) => self.parse(doc));
      return compile(tree, file);
    };
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 文字里的 `$`:能否不转义

const PHRASING_ROOTS = new Set(['paragraph', 'heading', 'tableCell']);

function markDollarText(node: MdNode, parse: (doc: string) => MdNode): void {
  if (!node.children) return;
  if (PHRASING_ROOTS.has(node.type)) {
    decideDollarText(node, parse);
    return;
  }
  for (const child of node.children) markDollarText(child, parse);
}

/** 这些 `$` 结构相关的字符原样进试解析串,其余字符换成 `a`(不会构成任何 Markdown 结构)。 */
function probeChar(ch: string): string {
  return ch === '$' || ch === ' ' || ch === '\n' || (ch >= '0' && ch <= '9') ? ch : ch === '\t' || ch === '\r' ? ' ' : 'a';
}

/**
 * 段落(标题 / 表格单元格)里的文字含 `$` 时,按「去掉这些 `$` 的转义」构造只保留 `$` / 空白 / 数字的试解析串,用同一解析器
 * 解析:得到的公式与段落里现有的公式逐一相同 → 文字里的 `$` 不转义(text.data.continuoDollar = 'raw')。
 * 无法确定的情形(文字含反斜杠或 `$$`、代码 / 链接地址 / HTML 里有 `$`、出现空行)一律转义。
 */
function decideDollarText(root: MdNode, parse: (doc: string) => MdNode): void {
  const texts: MdNode[] = [];
  const expected: string[] = [];
  let probe = 'a';
  let bail = false;
  const walk = (node: MdNode): void => {
    if (bail) return;
    switch (node.type) {
      case 'text': {
        const v = node.value ?? '';
        if (v.includes('$')) {
          if (v.includes('\\') || v.includes('$$')) bail = true;
          texts.push(node);
        }
        for (const ch of v) probe += probeChar(ch);
        return;
      }
      case 'inlineMath':
        expected.push(node.value ?? '');
        probe += inlineMathMarkdown(node) ?? canonicalInlineMath(node.value ?? '');
        return;
      case 'break':
        probe += '\n';
        return;
      default:
        break;
    }
    for (const field of [node.value, node.url, node.title, node.alt]) {
      if (typeof field === 'string' && field.includes('$')) bail = true;
    }
    // 强调 / 链接等的标记符(`*` `_` `~` `[` `](…)`)紧挨着文字:同样以 `a` 占位,两侧各一个
    probe += 'a';
    if (node.children) for (const child of node.children) walk(child);
    probe += 'a';
  };
  for (const child of root.children ?? []) walk(child);
  if (bail || texts.length === 0 || /\n[ ]*(?:\n|$)/.test(probe)) return;
  const found: string[] = [];
  let blocks = 0;
  const collect = (node: MdNode): void => {
    if (node.type === 'inlineMath') found.push(node.value ?? '');
    if (node.children) for (const child of node.children) collect(child);
  };
  let tree: MdNode;
  try {
    tree = parse(probe);
  } catch {
    return;
  }
  for (const child of tree.children ?? []) {
    blocks += 1;
    collect(child);
  }
  if (blocks !== 1 || tree.children![0]!.type !== 'paragraph') return;
  if (found.length !== expected.length || found.some((v, i) => v !== expected[i])) return;
  for (const t of texts) t.data = { ...t.data, continuoDollar: 'raw' };
}

/** 去掉(序列化时加的)`\$` 转义;`\\` 等其它转义原样保留。 */
export function unescapeDollars(s: string): string {
  if (!s.includes('\\$')) return s;
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length) {
      out += s[i + 1] === '$' ? '$' : ch + s[i + 1]!;
      i += 1;
    } else out += ch;
  }
  return out;
}

/** 给未转义的 `$` 加反斜杠(已有的转义原样保留)。 */
export function escapeDollars(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length) {
      out += ch + s[i + 1]!;
      i += 1;
    } else out += ch === '$' ? '\\$' : ch;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// ProseMirror schema:行内公式记原文;代码块区分 `$$` 公式块 / ```latex 围栏

interface PmNodeLike {
  readonly attrs: Record<string, unknown>;
  readonly type: { readonly name: string };
  readonly content: { readonly firstChild: { readonly text?: string } | null };
}
interface ParserStateLike {
  addNode(type: unknown, attrs?: Record<string, unknown>): unknown;
  openNode(type: unknown, attrs?: Record<string, unknown>): unknown;
  addText(text: string): unknown;
  closeNode(): unknown;
}
interface SerializerStateLike {
  addNode(type: string, children?: unknown, value?: string, props?: Record<string, unknown>): unknown;
}

/** 行内公式用 `$$` 写(`$$x$$`)→ 按块级样式显示(同 VSCode:`$$…$$` 渲染为公式块)。 */
function isDisplayRaw(raw: unknown): boolean {
  return typeof raw === 'string' && raw.startsWith('$$');
}

/** 覆盖 Crepe 的 math_inline(同 id 后注册者生效):多一个 raw 属性;渲染走懒加载的 KaTeX。 */
const mathInlineSchema = $nodeSchema(MATH_INLINE_ID, () => ({
  group: 'inline',
  inline: true,
  draggable: true,
  atom: true,
  attrs: {
    value: { default: '' },
    raw: { default: null },
  },
  parseDOM: [
    {
      tag: `span[data-type="${MATH_INLINE_ID}"]`,
      getAttrs: (dom: HTMLElement | string) => ({ value: (dom as HTMLElement).dataset.value ?? '' }),
    },
  ],
  toDOM: (node: PmNodeLike) => {
    const value = String(node.attrs.value ?? '');
    const dom = document.createElement('span');
    dom.dataset.type = MATH_INLINE_ID;
    dom.dataset.value = value;
    renderMathInto(dom, value, isDisplayRaw(node.attrs.raw));
    return dom;
  },
  parseMarkdown: {
    match: (node: MdNode) => node.type === 'inlineMath',
    runner: (state: ParserStateLike, node: MdNode, type: unknown) => {
      const raw = node.data?.continuoRaw;
      state.addNode(type, { value: node.value ?? '', raw: typeof raw === 'string' ? raw : null });
    },
  },
  toMarkdown: {
    match: (node: PmNodeLike) => node.type.name === MATH_INLINE_ID,
    runner: (state: SerializerStateLike, node: PmNodeLike) => {
      state.addNode('inlineMath', undefined, String(node.attrs.value ?? ''), { data: { continuoRaw: node.attrs.raw ?? null } });
    },
  },
}) as never);

function isLatexLanguage(language: unknown): boolean {
  return typeof language === 'string' && language.toLowerCase() === 'latex';
}

/**
 * 代码块多一个 math 属性:`$$` 公式块 = MathBlockInfo;Markdown 里的围栏 / 缩进代码块 = false;编辑器里新建(`$$ ` 输入规则、
 * 斜杠菜单「公式」)= null。语言为 latex 且 math 不是 false → 写成 `$$` 公式块,其余照常写成代码块。
 */
const codeBlockMathSchema = codeBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, math: { default: null } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const math = (node.data as Record<string, unknown> | undefined)?.continuoMath ?? false;
        state.openNode(type, { language: (node.lang as string | null | undefined) ?? '', math });
        if (node.value) state.addText(node.value as string);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        const math = node.attrs.math as MathBlockInfo | false | null;
        if (!isLatexLanguage(node.attrs.language) || math === false) {
          base.toMarkdown.runner(state, node);
          return;
        }
        state.addNode('math', undefined, node.content.firstChild?.text || '', {
          meta: math?.meta ?? null,
          data: { continuoMath: math ?? null },
        });
      },
    },
  };
});

/** 代码块预览:`$$` 公式块与 ```latex / ```math 围栏渲染成公式(VSCode 同样渲染 ```math 围栏)。 */
export function isMathPreviewLanguage(language: string): boolean {
  const l = language.toLowerCase();
  return l === 'latex' || l === 'math';
}

type TextHandler = (node: MdNode, parent: unknown, state: unknown, info: unknown) => string;
type RenderPreview = (language: string, content: string, applyPreview: (value: null | string | HTMLElement) => void) => unknown;

/** 在 crepe.create() 之前、configureMarkdownStyle 之后调用(Crepe 已启用 CrepeFeature.Latex)。 */
export function configureMarkdownMath(crepe: Crepe): void {
  const editor = crepe.editor;
  editor.use(continuoMathRemark);
  editor.use(mathInlineSchema);
  editor.use(codeBlockMathSchema);
  editor.config((ctx) => {
    ctx.update(codeBlockConfig.key, (prev) => {
      const prevRender = prev.renderPreview as RenderPreview;
      return {
        ...prev,
        renderPreview: ((language, content, applyPreview) =>
          isMathPreviewLanguage(language)
            ? renderMathPreview(content, applyPreview)
            : prevRender(language, content, applyPreview)) as typeof prev.renderPreview,
      };
    });
    ctx.update(remarkStringifyOptionsCtx, (prev) => {
      const text = (prev.handlers as Record<string, TextHandler> | undefined)?.text;
      if (!text) return prev;
      const handler: TextHandler = (node, parent, state, info) => {
        const out = text(node, parent, state, info);
        if (!(node.value ?? '').includes('$')) return out;
        const plain = unescapeDollars(out);
        return node.data?.continuoDollar === 'raw' ? plain : escapeDollars(plain);
      };
      return { ...prev, handlers: { ...prev.handlers, text: handler as never } };
    });
  });
}
