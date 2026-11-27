// Markdown 编辑模式(Milkdown):编辑自动链接(原文是裸链接 `https://…` / `www.…` / 邮箱,或 `<url>`,即链接文字 = 地址)的文字时,
// 地址跟随文字(Typora / Obsidian 实时预览:自动链接的地址就是它的文字)。否则链接 mark 是 inclusive 的,接着 URL 打字只改了文字,
// 保存成 `[https://example.com/p](https://example.com)` —— 文字与地址分家,点击跳原地址。
//
// 规则(PM appendTransaction,只看这次编辑碰到的、编辑前文字 = 地址的链接,以及紧跟在它后面、GFM 会连着看的文字):
//  - 裸链接形状(http(s):// / www. / 邮箱)按 GFM 自动链接文字重新认定 —— 直接用解析器(gfmLiteralLinkAt,与保存后重新打开的认定
//    一致):从链接开头到空白为止的一段(含链接后紧跟的文字,如句末标点后续写的 `.cn` / `?q=1`)里 GFM 认作链接的开头部分加链接、
//    地址 = 这部分(www. 补 http://,邮箱补 mailto:),其余去掉链接;GFM 不计入链接的结尾标点照常是文字,再往后打字链接随之延长。
//    开头不再合法 / 前一个字符使它不再是链接(在链接前紧挨着打了字母、删掉了前面的空格)→ 去掉链接
//  - 其它协议(`<ftp://…>` 之类)按 CommonMark 自动链接:取到空白为止,仍是「协议:…」形状 → 地址 = 文字,否则去掉链接
//  - 文字 ≠ 地址的链接(`[文字](地址)`)不动
//  - 编辑碰到的普通文字词(不含链接、不在代码 / 代码块里)按 GFM 认作链接 → 补链接(新打的网址 / www. / 邮箱、`https//…` 补上 `:`;
//    粘贴的纯文本同理)。与保存后重新打开 / GitHub / VSCode 纯文本一致;否则序列化按 GFM 转义成 `https\://…` / `www\.…` / `a\@…`。
//    补链接与触发它的那次输入同一步撤销;只去掉链接(只改 mark)不算编辑文字,不补回 —— 但 Markdown 里裸写的网址本就是链接,
//    保存后重新打开仍是链接(Milkdown 的 GFM 解析连 `https\://…` 也认作链接),要纯文字的网址用行内代码
//  - 输入法组字期间不改文档(组字中改 mark 会打断输入法):记下组字的事务,组字结束后(下一个非组字事务 / compositionend 之后)补判
// 序列化(milkdown-markdown-style 的裸写判定 / milkdown-source-blocks 的就地改原文)据此得到文字与地址一致的链接。
// BDD: src/__tests__/editor-markdown-autolink-edit/

import { Mark, type MarkType, type Node as PmNode } from '@milkdown/kit/prose/model';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import { Mapping } from '@milkdown/kit/prose/transform';
import type { EditorView } from '@milkdown/kit/prose/view';

interface Run {
  readonly from: number;
  readonly to: number;
  readonly mark: Mark;
  readonly text: string;
  /** 链接前一个字符(同一文本块内;块首 → null)。 */
  readonly before: string | null;
}

/** 文本块里连续带同一链接 mark 的文字段。 */
function linkRuns(block: PmNode, start: number, type: MarkType): Run[] {
  const runs: { from: number; to: number; mark: Mark; text: string }[] = [];
  block.forEach((child, offset) => {
    const a = start + offset;
    const mark = child.isText ? type.isInSet(child.marks) : undefined;
    if (!mark) return;
    const last = runs.at(-1);
    if (last && last.mark.eq(mark) && last.to === a) {
      last.to = a + child.nodeSize;
      last.text += child.text!;
    } else runs.push({ from: a, to: a + child.nodeSize, mark, text: child.text! });
  });
  return runs.map((r) => {
    const before = r.from > start ? block.textBetween(r.from - start - 1, r.from - start, '\n', '\n') : null;
    return { ...r, before };
  });
}

const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/;
// `www` 不带点:GFM 把刚打出的 `www.` 认作链接 `www`(地址 http://www,句点不计入),接着打字随之延长
const WEB = /^(?:https?:\/\/|www)/i;

/** 文字 = 地址(自动链接:`<url>` / 裸链接 / www.(地址补 http://)/ 邮箱(地址补 mailto:))。 */
function isAutolink(text: string, href: string, title: unknown): boolean {
  if (title || !text) return false;
  return href === text || href === `mailto:${text}` || (/^www/i.test(text) && href === `http://${text}`);
}

/** GFM 裸链接形状(http(s):// / www. / 邮箱)。 */
function isGfmShaped(text: string): boolean {
  return WEB.test(text) || EMAIL.test(text);
}

/** 解析 Markdown 为 mdast(Milkdown remarkCtx 的 parse:含 GFM 自动链接文字扩展,与保存后重新打开同一解析器)。 */
export type ParseMarkdown = (markdown: string) => unknown;

interface MdNode {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
  readonly title?: string | null;
  readonly children?: readonly MdNode[];
}

/** 一处 GFM 自动链接文字:在所给文字里的起点、长度与地址。 */
export interface LiteralLink {
  readonly from: number;
  readonly length: number;
  readonly href: string;
}

/**
 * GFM 自动链接文字的认定(micromark-extension-gfm-autolink-literal + mdast-util-gfm-autolink-literal —— 直接用解析器,不另写规则):
 * 紧跟在字符 `before`(块首 / 换行 → null)之后的文字 `segment`(到空白为止)里被认作链接的各段;解析出别的结构(强调、代码…)
 * 或文字对不上(转义 / 实体)→ null(不认定)。结尾标点(`.` `?` `,` …)、不配对的 `)` 等按 GFM 不计入链接(文字仍在);
 * GFM 算进链接的(全角标点「。」、`.cn` 之类)照算。编辑跟随(本文件)与序列化的裸写判定(milkdown-markdown-style)共用,两边认定一致。
 */
export function gfmLiteralLinks(parse: ParseMarkdown, before: string | null, segment: string): LiteralLink[] | null {
  // 前面垫一个字母:前一个字符(`>` `#` `-` …)不会成为块结构的开头
  const prefix = `x${before === null || before === '\n' ? ' ' : before}`;
  const source = prefix + segment;
  const para = (parse(source) as MdNode).children?.[0];
  if (para === undefined) return [];
  if (para.type !== 'paragraph') return null;
  const out: LiteralLink[] = [];
  let at = 0;
  for (const node of para.children ?? []) {
    const kids = node.children ?? [];
    const text =
      node.type === 'text'
        ? (node.value ?? '')
        : node.type === 'link' && !node.title && node.url && kids.length === 1 && kids[0]!.type === 'text'
          ? (kids[0]!.value ?? '')
          : null;
    if (text === null || source.slice(at, at + text.length) !== text) return null;
    if (node.type === 'link') {
      if (at < prefix.length) return null;
      out.push({ from: at - prefix.length, length: text.length, href: node.url! });
    }
    at += text.length;
  }
  return at === source.length ? out : null;
}

/** `segment` 开头(紧跟 `before`)按 GFM 认作链接的长度与地址;开头不是链接 → null。 */
export function gfmLiteralLinkAt(
  parse: ParseMarkdown,
  before: string | null,
  segment: string,
): { readonly length: number; readonly href: string } | null {
  const first = gfmLiteralLinks(parse, before, segment)?.[0];
  return first?.from === 0 ? first : null;
}

/** 其它协议的 `<url>`(CommonMark 自动链接):取到空白为止,仍是「协议:…」/ 邮箱形状 → 地址 = 文字。 */
function relinkCommonMark(text: string): { readonly length: number; readonly href: string } | null {
  const s = /^[^\s<>]*/.exec(text)![0];
  if (EMAIL.test(s) && EMAIL.exec(s)![0] === s) return { length: s.length, href: `mailto:${s}` };
  return /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(s) ? { length: s.length, href: s } : null;
}

interface Word {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  /** 词前一个字符(同一文本块内;块首 → null)。 */
  readonly before: string | null;
  /** 在行内代码里。 */
  readonly code: boolean;
}

/**
 * 文本块里 GFM 连着看的「词」:连续的非空白文字(链接与其前后紧挨着的文字算同一个词,如 `https://example.com.cn` 里句末标点后续写的
 * `cn`);非文字节点、链接以外的 mark(加粗 / 行内代码 …)变化处断开。
 */
function wordsIn(block: PmNode, start: number, type: MarkType): Word[] {
  const words: Word[] = [];
  let cur: { from: number; text: string; marks: readonly Mark[] } | null = null;
  const flush = (): void => {
    if (cur) {
      const before = cur.from > start ? block.textBetween(cur.from - start - 1, cur.from - start, '\n', '\n') : null;
      const code = cur.marks.some((m) => m.type.spec.code);
      words.push({ from: cur.from, to: cur.from + cur.text.length, text: cur.text, before, code });
    }
    cur = null;
  };
  block.forEach((child, offset) => {
    if (!child.isText) return flush();
    const marks = type.removeFromSet(child.marks);
    if (cur && !Mark.sameSet(cur.marks, marks)) flush();
    let pos = start + offset;
    for (const ch of child.text!) {
      if (/\s/u.test(ch)) flush();
      else {
        cur ??= { from: pos, text: '', marks };
        cur.text += ch;
      }
      pos += ch.length;
    }
  });
  flush();
  return words;
}

/** 编辑前的一个自动链接(文字 = 地址)。literal:恰是 GFM 会认出的那一段(裸链接),否则只有 `<url>` 才成立。 */
interface OldAutolink {
  readonly mark: Mark;
  readonly gfm: boolean;
  readonly literal: boolean;
}

/** 编辑前、改动所在文本块里的自动链接。 */
function oldAutolinks(doc: PmNode, ranges: readonly [number, number][], type: MarkType, parse: ParseMarkdown): OldAutolink[] {
  const out: OldAutolink[] = [];
  const seen = new Set<number>();
  for (const [a, b] of ranges) {
    doc.nodesBetween(Math.max(0, a - 1), Math.min(doc.content.size, b + 1), (block, pos) => {
      if (!block.isTextblock) return true;
      if (seen.has(pos)) return false;
      seen.add(pos);
      let words: Word[] | null = null;
      for (const run of linkRuns(block, pos + 1, type)) {
        if (!isAutolink(run.text, run.mark.attrs.href as string, run.mark.attrs.title)) continue;
        const gfm = isGfmShaped(run.text);
        words ??= wordsIn(block, pos + 1, type);
        const word = words.find((w) => w.from <= run.from && run.to <= w.to);
        const literal =
          gfm &&
          word !== undefined &&
          !word.code &&
          (gfmLiteralLinks(parse, word.before, word.text) ?? []).some(
            (l) => word.from + l.from === run.from && l.length === run.text.length && l.href === run.mark.attrs.href,
          );
        out.push({ mark: run.mark, gfm, literal });
      }
      return false;
    });
  }
  return out;
}

// 可能被 GFM 认作链接文字的词(省掉多数词的试解析)
const LITERAL_HINT = /https?:\/\/|www\.|@|mailto:|xmpp:/i;

/** 词里没有链接、不在行内代码里,且按 GFM 认出链接文字 → 这些链接;否则 null。 */
function plainLiterals(block: PmNode, start: number, word: Word, type: MarkType, parse: ParseMarkdown): LiteralLink[] | null {
  if (word.code || !LITERAL_HINT.test(word.text)) return null;
  if (linkRuns(block, start, type).some((r) => r.from < word.to && r.to > word.from)) return null;
  const found = gfmLiteralLinks(parse, word.before, word.text);
  return found && found.length > 0 ? found : null;
}

/** 解析结果对不上文字时(转义 / 实体):地址 = 文字(www. 补 http://,邮箱补 mailto:)。 */
function hrefOfText(text: string): string {
  if (/^www\./i.test(text)) return `http://${text}`;
  return !WEB.test(text) && EMAIL.test(text) ? `mailto:${text}` : text;
}

function sameLinks(a: readonly LiteralLink[], b: readonly LiteralLink[]): boolean {
  return a.length === b.length && a.every((x, i) => x.from === b[i]!.from && x.length === b[i]!.length && x.href === b[i]!.href);
}

/**
 * appendTransaction:这批事务改动碰到的自动链接按编辑后的文字重新认定(见文件头)。无需改动 → null。
 */
export function followEditedAutolinks(
  trs: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
  type: MarkType,
  parse: ParseMarkdown,
): Transaction | null {
  if (!trs.some((tr) => tr.docChanged)) return null;
  const mapping = new Mapping();
  for (const tr of trs) mapping.appendMapping(tr.mapping);
  // 改动在编辑前 / 编辑后文档里的区间
  const ranges: [number, number][] = [];
  mapping.maps.forEach((map, i) => {
    const back = mapping.slice(0, i).invert();
    map.forEach((from, to) => ranges.push([back.map(from, -1), back.map(to, 1)]));
  });
  const autos = oldAutolinks(oldState.doc, ranges, type, parse);
  const infoOf = (mark: Mark): OldAutolink | undefined => autos.find((o) => o.mark.eq(mark));
  const doc = newState.doc;
  let out: Transaction | null = null;
  const tr = (): Transaction => (out ??= newState.tr);
  const done = new Set<string>();
  for (const [a, b] of ranges) {
    const na = mapping.map(a, -1);
    const nb = mapping.map(b, 1);
    doc.nodesBetween(Math.max(0, na - 1), Math.min(doc.content.size, nb + 1), (block, pos) => {
      if (!block.isTextblock) return true;
      if (block.type.spec.code || done.has(`b${pos}`)) return false;
      done.add(`b${pos}`);
      const start = pos + 1;
      const runs = linkRuns(block, start, type).filter((r) => infoOf(r.mark) !== undefined);
      const touched = (from: number, to: number): boolean => from <= nb && to >= na;
      for (const run of runs) {
        if (!touched(run.from, run.to)) continue;
        const info = infoOf(run.mark)!;
        if (info.literal) {
          // 链接中间打了空格:空白不带链接(两边的词下面各自认定)
          for (const m of run.text.matchAll(/\s+/gu)) tr().removeMark(run.from + m.index, run.from + m.index + m[0].length, type);
          continue;
        }
        // 只有尖括号才成立的(`x<https://…>`、`<https://…>abc`)/ 其它协议:只看链接本身的文字
        const one = info.gfm ? gfmLiteralLinkAt(parse, null, run.text) : relinkCommonMark(run.text);
        if (one && one.length === run.text.length && one.href === run.mark.attrs.href) continue;
        tr().removeMark(run.from, run.to, type);
        if (one) tr().addMark(run.from, run.from + one.length, type.create({ ...run.mark.attrs, href: one.href }));
      }
      // 碰到的词里有裸链接(且没有别的链接):整词按 GFM 重新认定(链接前后紧挨着的文字一并看,GFM 认出几段就是几段)
      for (const word of wordsIn(block, start, type)) {
        if (!touched(word.from, word.to) || word.code) continue;
        const inWord = runs.filter((r) => r.from < word.to && r.to > word.from);
        if (inWord.length === 0) {
          // 普通文字词随这次编辑成了链接形状 → 补链接
          const found = plainLiterals(block, start, word, type, parse) ?? [];
          for (const l of found) tr().addMark(word.from + l.from, word.from + l.from + l.length, type.create({ href: l.href }));
          continue;
        }
        if (!inWord.every((r) => infoOf(r.mark)!.literal)) continue;
        // 词里还有别的链接(`[文字](地址)`)→ 不动
        if (linkRuns(block, start, type).some((r) => r.from < word.to && r.to > word.from && !infoOf(r.mark))) continue;
        const current = inWord.map((r) => {
          const from = Math.max(r.from, word.from);
          return { from: from - word.from, length: Math.min(r.to, word.to) - from, href: r.mark.attrs.href as string };
        });
        const next =
          gfmLiteralLinks(parse, word.before, word.text) ??
          current.map((l) => ({ ...l, href: hrefOfText(word.text.slice(l.from, l.from + l.length)) }));
        if (sameLinks(current, next)) continue;
        tr().removeMark(word.from, word.to, type);
        const attrs = inWord[0]!.mark.attrs;
        for (const l of next) {
          tr().addMark(word.from + l.from, word.from + l.from + l.length, type.create({ ...attrs, href: l.href }));
        }
      }
      return false;
    });
  }
  return out;
}

/**
 * 带输入法组字处理的跟随:组字期间(事务带 composition meta / view.composing)只记下事务、不改文档;组字结束后的第一个非组字事务
 * 连同记下的事务一起判定。compositionEnd:组字结束后没有后续事务时(compositionend 之后 ProseMirror 收尾完)补派一个空事务触发判定。
 */
export function createAutolinkFollower(type: () => MarkType, parse: () => ParseMarkdown) {
  let pending: { trs: Transaction[]; old: EditorState; doc: PmNode } | null = null;
  let view: EditorView | null = null;
  return {
    setView(v: EditorView | null): void {
      view = v;
    },
    append(trs: readonly Transaction[], old: EditorState, state: EditorState): Transaction | null {
      // 链条断了(期间有事务没经过这里)→ 丢掉记下的
      if (pending && pending.doc !== old.doc) pending = null;
      if (view?.composing || trs.some((tr) => tr.getMeta('composition') !== undefined)) {
        pending = pending ? { ...pending, trs: [...pending.trs, ...trs], doc: state.doc } : { trs: [...trs], old, doc: state.doc };
        return null;
      }
      const all = pending ? [...pending.trs, ...trs] : trs;
      const from = pending ? pending.old : old;
      pending = null;
      return followEditedAutolinks(all, from, state, type(), parse());
    },
    /** 收到 compositionend:等 ProseMirror 收尾(其 20ms 的 endComposition)后,仍有记下的组字事务且已不在组字 → 补判。 */
    compositionEnd(v: EditorView): void {
      setTimeout(() => {
        if (pending && !v.composing && !v.isDestroyed) v.dispatch(v.state.tr);
      }, 50);
    },
    /** 丢掉记下的组字事务(内容被整体替换 / 跟随被别的处理顶替)。 */
    reset(): void {
      pending = null;
    },
  };
}
