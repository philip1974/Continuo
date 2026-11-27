// Markdown 编辑模式(Milkdown):编辑自动链接(原文是裸链接 `https://…` / `www.…` / 邮箱,或 `<url>`,即链接文字 = 地址)的文字时,
// 地址跟随文字(Typora / Obsidian 实时预览:自动链接的地址就是它的文字)。否则链接 mark 是 inclusive 的,接着 URL 打字只改了文字,
// 保存成 `[https://example.com/p](https://example.com)` —— 文字与地址分家,点击跳原地址。
//
// 规则(PM appendTransaction,只看这次编辑碰到的、编辑前文字 = 地址的链接):
//  - 编辑后的文字按 GFM 自动链接规则重新认定:裸链接形状(http(s):// / www. / 邮箱)取开头合法的那段(遇空白截止,去掉 GFM 不算进
//    链接的句末标点、不配对的右括号),只给这段加链接、地址 = 这段(www. 补 http://,邮箱补 mailto:),其余文字去掉链接;开头不再
//    合法 → 整段去掉链接。前一个字符原本合法、编辑后不合法(在链接前紧挨着打了字母 / 删掉了前面的空格)→ 同样去掉链接
//  - 其它协议(`<ftp://…>` 之类)按 CommonMark 自动链接:取到空白为止,仍是「协议:…」形状 → 地址 = 文字,否则去掉链接
//  - 文字 ≠ 地址的链接(`[文字](地址)`)不动;输入法组字期间不动(组字中改 mark 会打断输入法)
// 序列化(milkdown-markdown-style 的裸写判定 / milkdown-source-blocks 的就地改原文)据此得到文字与地址一致的链接。
// BDD: src/__tests__/editor-markdown-autolink-edit/

import type { Mark, MarkType, Node as PmNode } from '@milkdown/kit/prose/model';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import { Mapping } from '@milkdown/kit/prose/transform';

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

/** [from, to] 附近(含紧挨着)的链接段。 */
function runsNear(doc: PmNode, from: number, to: number, type: MarkType): Run[] {
  const out: Run[] = [];
  doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos) => {
    if (!node.isTextblock) return true;
    for (const r of linkRuns(node, pos + 1, type)) if (r.from <= to && r.to >= from) out.push(r);
    return false;
  });
  return out;
}

const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/;
const WEB = /^(?:https?:\/\/|www\.)/i;

/** 文字 = 地址(自动链接:`<url>` / 裸链接 / www.(地址补 http://)/ 邮箱(地址补 mailto:))。 */
function isAutolink(text: string, href: string, title: unknown): boolean {
  if (title || !text) return false;
  return href === text || href === `mailto:${text}` || (/^www\./i.test(text) && href === `http://${text}`);
}

/** GFM 裸链接形状(http(s):// / www. / 邮箱)。 */
function isGfmShaped(text: string): boolean {
  return WEB.test(text) || EMAIL.test(text);
}

/** GFM 自动链接对前一个字符的要求(micromark-extension-gfm-autolink-literal previousProtocol / previousWww / previousEmail)。 */
function gfmPreviousOk(text: string, before: string | null): boolean {
  if (before === null || before === '\n') return true;
  if (/^https?:\/\//i.test(text)) return !/[A-Za-z]/.test(before);
  if (/^www\./i.test(text)) return /[\s(*_[\]~]/.test(before);
  return !/[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]/.test(before);
}

/** 文字开头按 GFM 认作裸链接的长度(0 = 不是链接)。 */
function gfmLinkLength(text: string): number {
  const email = EMAIL.exec(text);
  if (email) {
    let s = email[0];
    while (/[._+-]$/.test(s)) s = s.slice(0, -1);
    return /@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(s) ? s.length : 0;
  }
  const prefix = WEB.exec(text);
  if (!prefix) return 0;
  let s = /^[^\s<]*/.exec(text)![0];
  // GFM 不算进链接的结尾:句末标点、不配对的右括号、像实体的 `&x;`
  for (;;) {
    const prev = s;
    s = s.replace(/[?!.,:*_~'";]+$/, '').replace(/&[A-Za-z0-9]+;$/, '');
    if (s.endsWith(')') && s.split('(').length < s.split(')').length) s = s.slice(0, -1);
    if (s === prev) break;
  }
  const domain = /^[^/?#]*/.exec(s.slice(prefix[0].length))![0];
  return /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*(?::\d+)?$/u.test(domain) ? s.length : 0;
}

/** 编辑后文字里仍是链接的开头一段与它的地址;不是链接 → null。 */
function relink(text: string, before: string | null, gfm: boolean): { readonly length: number; readonly href: string } | null {
  if (gfm) {
    if (!gfmPreviousOk(text, before)) return null;
    const length = gfmLinkLength(text);
    if (length === 0) return null;
    const s = text.slice(0, length);
    const href = WEB.test(s) ? (/^www\./i.test(s) ? `http://${s}` : s) : `mailto:${s}`;
    return { length, href };
  }
  const s = /^[^\s<>]*/.exec(text)![0];
  if (EMAIL.test(s) && EMAIL.exec(s)![0] === s) return { length: s.length, href: `mailto:${s}` };
  return /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.test(s) ? { length: s.length, href: s } : null;
}

/**
 * appendTransaction:这批事务改动碰到的自动链接按编辑后的文字重新认定(见文件头)。无需改动 → null。
 */
export function followEditedAutolinks(
  trs: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
  type: MarkType,
): Transaction | null {
  if (!trs.some((tr) => tr.docChanged)) return null;
  if (trs.some((tr) => tr.getMeta('composition') !== undefined)) return null;
  const mapping = new Mapping();
  for (const tr of trs) mapping.appendMapping(tr.mapping);
  // 改动在编辑前文档里的区间
  const ranges: [number, number][] = [];
  mapping.maps.forEach((map, i) => {
    const back = mapping.slice(0, i).invert();
    map.forEach((from, to) => ranges.push([back.map(from, -1), back.map(to, 1)]));
  });
  const seen = new Set<number>();
  let out: Transaction | null = null;
  for (const [a, b] of ranges) {
    for (const old of runsNear(oldState.doc, a, b, type)) {
      if (seen.has(old.from) || !isAutolink(old.text, old.mark.attrs.href as string, old.mark.attrs.title)) continue;
      seen.add(old.from);
      const gfm = isGfmShaped(old.text);
      // 原本就不满足 GFM 前一个字符的要求(`x<https://…>`):不按它判定
      const checkBefore = gfm && gfmPreviousOk(old.text, old.before);
      const nf = mapping.map(old.from, -1);
      const nt = mapping.map(old.to, 1);
      for (const run of runsNear(newState.doc, nf, nt, type)) {
        if (!run.mark.eq(old.mark) || run.from >= nt || run.to <= nf) continue;
        if (run.text === old.text && run.before === old.before) continue;
        const next = relink(run.text, checkBefore ? run.before : null, gfm);
        if (next && next.length === run.text.length && next.href === run.mark.attrs.href) continue;
        out ??= newState.tr;
        out.removeMark(run.from, run.to, type);
        if (next) out.addMark(run.from, run.from + next.length, type.create({ ...run.mark.attrs, href: next.href }));
      }
    }
  }
  return out;
}
