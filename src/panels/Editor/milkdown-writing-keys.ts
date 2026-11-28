// Markdown 编辑模式(Milkdown)的写作按键(BDD: src/__tests__/editor-markdown-writing-keys/):
//  - 选中文字后粘贴单个 URL → 给选区加链接(VSCode markdown.editor.pasteUrlAsFormattedLink;Typora / Obsidian 同),
//    而不是用 URL 替换选中文字。
//  - ⌘K / Ctrl+K → 打开 Crepe 的链接编辑框(Typora / Obsidian):光标 / 选区在链接里 → 编辑该链接地址;否则给选区加链接
//   (没有选区 → 插入地址本身作链接文字)。按键落在 ProseMirror 里由这里处理并 preventDefault,全局「清除终端」(mac ⌘K,
//    只作用于终端)不再收到(useCommandHotkeys 对编辑器里已处理的键让行)。
//  - 加链接(⌘K 链接框确认 / 粘贴 URL)后光标收到链接末尾,接着输入的文字不带链接(VSCode 粘贴成格式化链接后光标在插入内容
//    末尾;链接 mark 是 inclusive 的,不收起会替换掉链接文字、收起后不清 storedMarks 会把输入并进链接)。
//  - 编辑自动链接(裸链接 / `<url>`,文字 = 地址)的文字 → 地址跟随文字(milkdown-autolink-follow;输入法组字结束后补判)。
//  - 拆段(回车)落在空白前:新段段首的空格 / 制表符去掉(CommonMark 段首空白不属于内容;否则保存成 `&#x20;tail`,编辑器里
//    却显示成空格开头)。与回车同一步撤销。全角空格(U+3000)等不是 Markdown 空白,保留;落在行内代码里不删(代码内容)。
//  - 表格里 Tab:下一格;最后一格 → 在表格末尾加一行并进入其首格(不再由缩进插件在格内插 4 个空格)。⇧Tab:上一格;首格 → 不动。

import { linkTooltipAPI, linkTooltipState } from '@milkdown/kit/component/link-tooltip';
import { linkSchema } from '@milkdown/kit/preset/commonmark';
import { addRowWithAlignment } from '@milkdown/kit/preset/gfm';
import { prosePluginsCtx, remarkCtx, SchemaReady } from '@milkdown/kit/core';
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx';
import { keydownHandler } from '@milkdown/kit/prose/keymap';
import type { Mark, MarkType } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import { AddMarkStep, ReplaceStep } from '@milkdown/kit/prose/transform';
import { createAutolinkFollower, type ParseMarkdown } from './milkdown-autolink-follow';
import { goToNextCell, isInTable, selectedRect } from '@milkdown/kit/prose/tables';
import type { EditorView } from '@milkdown/kit/prose/view';
import { pasteEditorCopyAsMarkdown } from './milkdown-paste';

/** 剪贴板纯文本是否单个 URL(两端空白忽略;中间不得有空白)。 */
export function pastedUrl(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  return /^(?:https?|ftp|file):\/\/\S+$/i.test(t) || /^mailto:[^\s@]+@\S+$/i.test(t) ? t : null;
}

/** 选区是否落在代码里(代码块 / 行内代码):那里粘贴 / ⌘K 照常。 */
function inCode(state: EditorState): boolean {
  const { $from, from, to } = state.selection;
  if ($from.parent.type.spec.code) return true;
  let code = false;
  state.doc.nodesBetween(from, Math.max(to, from + 1), (node) => {
    if (node.marks.some((m) => m.type.spec.code)) code = true;
  });
  return code;
}

/** 光标(在链接文字内部)/ 选区(整个落在链接里)所在的链接及其完整范围。 */
function linkAt(state: EditorState, type: MarkType): { mark: Mark; from: number; to: number } | null {
  const { $from, from, to, empty } = state.selection;
  if (!$from.sameParent(state.selection.$to)) return null;
  const parent = $from.parent;
  const start = $from.start();
  const runs: { mark: Mark; from: number; to: number }[] = [];
  parent.forEach((child, offset) => {
    const a = start + offset;
    const mark = type.isInSet(child.marks);
    if (!mark) return;
    const last = runs.at(-1);
    if (last && last.mark.eq(mark) && last.to === a) last.to = a + child.nodeSize;
    else runs.push({ mark, from: a, to: a + child.nodeSize });
  });
  return runs.find((r) => (empty ? r.from < from && from < r.to : r.from <= from && to <= r.to)) ?? null;
}

function openLinkEditor(ctx: Ctx, view: EditorView): boolean {
  if (!view.editable) return false;
  const { state } = view;
  if (inCode(state)) return false;
  const type = linkSchema.type(ctx);
  const api = ctx.get(linkTooltipAPI.key);
  const link = linkAt(state, type);
  if (link) api.editLink(link.mark, link.from, link.to);
  else api.addLink(state.selection.from, state.selection.to);
  return true;
}

function tableTab(ctx: Ctx, dir: 1 | -1, state: EditorState, dispatch?: EditorView['dispatch'], view?: EditorView): boolean {
  if (!isInTable(state)) return false;
  if (goToNextCell(dir)(state, dispatch)) return true;
  if (dir === -1 || !dispatch || !view) return true; // 首格 ⇧Tab:不动(不交给缩进插件)
  // 最后一格:加一行(对齐方式随表头列)后跳进新行首格
  const rect = selectedRect(state);
  dispatch(addRowWithAlignment(ctx, state.tr, rect, rect.bottom).scrollIntoView());
  goToNextCell(1)(view.state, view.dispatch);
  return true;
}

/** 光标收到 `pos`(链接末尾),之后输入不带链接 mark。 */
function collapseAfterLink(tr: Transaction, pos: number, type: MarkType): Transaction {
  const $pos = tr.doc.resolve(pos);
  return tr.setSelection(TextSelection.create(tr.doc, pos)).setStoredMarks(type.removeFromSet($pos.marks()));
}

/**
 * ⌘K / 工具条的链接框确认:Crepe 在链接框(edit 模式)里对选区 addMark 后不动选区 → 收到链接末尾(没有选区时 Crepe 插入地址
 * 作链接文字,光标已在其后,只清掉接着输入会带上的链接)。只认链接框打开期间、恰好覆盖当前选区 / 止于光标的那一步加链接。
 */
function collapseConfirmedLink(ctx: Ctx, trs: readonly Transaction[], state: EditorState): Transaction | null {
  if (ctx.get(linkTooltipState.key).mode !== 'edit') return null;
  const type = linkSchema.type(ctx);
  const { from, to, empty } = state.selection;
  const added = trs.some((tr) =>
    tr.steps.some(
      (step) => step instanceof AddMarkStep && step.mark.type === type && step.to === to && (empty || step.from === from),
    ),
  );
  return added ? collapseAfterLink(state.tr, to, type) : null;
}

/**
 * 这批事务把文本块从中间拆开(回车:splitBlock / 列表项拆分,插入的只是块边界),拆点后紧跟空格 / 制表符,光标落在新块开头 →
 * 新块段首这段空白的范围(state.doc 里);否则 null。拆点在块首(新块是原来的整块)不算。
 */
function splitLeadingSpace(trs: readonly Transaction[], state: EditorState): { from: number; to: number } | null {
  const split = trs.some((tr) =>
    tr.steps.some((step, i) => {
      if (!(step instanceof ReplaceStep) || step.from !== step.to) return false;
      const { slice } = step;
      if (slice.openStart === 0 || slice.openEnd === 0 || slice.content.textBetween(0, slice.content.size) !== '') return false;
      const $pos = tr.docs[i]!.resolve(step.from);
      const after = $pos.nodeAfter;
      return $pos.parent.isTextblock && $pos.parentOffset > 0 && !!after?.isText && /^[ \t]/.test(after.text!);
    }),
  );
  if (!split) return null;
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || !$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  const first = $from.parent.firstChild;
  // 行内代码里的空格是代码内容(保存成 `` ` de` `` 原样读回),不删;强调 / 链接 / 删除线里的段首空格保存时被移到标记外、落在
  // 段首,重新打开即被 CommonMark 丢弃 → 照删(编辑器里与保存一致)
  if (first?.marks.some((m) => m.type.spec.code)) return null;
  const lead = first?.isText ? /^[ \t]+/.exec(first.text!)?.[0] : undefined;
  return lead ? { from: $from.pos, to: $from.pos + lead.length } : null;
}

const writingKeysKey = new PluginKey('continuoMarkdownWritingKeys');

/** 选中文字后粘贴单个 URL → 给选区加链接(handlePaste)。 */
function pasteUrlAsLink(ctx: Ctx, view: EditorView, event: ClipboardEvent): boolean {
  if (!view.editable) return false;
  const { selection } = view.state;
  if (selection.empty || !(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)) return false;
  const data = event.clipboardData;
  if (!data || data.files.length > 0) return false;
  const url = pastedUrl(data.getData('text/plain'));
  if (!url || inCode(view.state)) return false;
  const type = linkSchema.type(ctx);
  const tr = view.state.tr.addMark(selection.from, selection.to, type.create({ href: url }));
  view.dispatch(collapseAfterLink(tr, selection.to, type).scrollIntoView());
  return true;
}

function createWritingKeysPlugin(ctx: Ctx): Plugin {
  const keydown = keydownHandler({
    'Mod-k': (_state, _dispatch, view) => (view ? openLinkEditor(ctx, view) : false),
    Tab: (state, dispatch, view) => tableTab(ctx, 1, state, dispatch, view),
    'Shift-Tab': (state, dispatch, view) => tableTab(ctx, -1, state, dispatch, view),
  });
  // 链接框确认后 Crepe 在下一帧直接 DOM focus 编辑区(不经 view.focus,链接框聚焦期间 DOM 选区没跟着收起):这次聚焦时
  // 按 state 里已收起的选区写回 DOM 选区,否则随后的 selectionchange 把光标读成文首
  let resyncOnFocusUntil = 0;
  // 编辑自动链接的文字 → 地址跟随文字(见 milkdown-autolink-follow);按保存后重新打开的同一解析器(remark + GFM)认定链接
  const follower = createAutolinkFollower(
    () => linkSchema.type(ctx),
    () => {
      const remark = ctx.get(remarkCtx) as unknown as { parse: ParseMarkdown };
      return (markdown) => remark.parse(markdown);
    },
  );
  return new Plugin({
    key: writingKeysKey,
    view: (view) => {
      follower.setView(view);
      return { destroy: () => follower.setView(null) };
    },
    appendTransaction: (trs, old, state) => {
      const tr = collapseConfirmedLink(ctx, trs, state);
      if (!tr) {
        // 自动链接跟随只改 mark(位置不变),段首空白的删除并进同一事务
        const follow = follower.append(trs, old, state);
        const lead = splitLeadingSpace(trs, state);
        if (!lead) return follow;
        return (follow ?? state.tr).delete(lead.from, lead.to);
      }
      resyncOnFocusUntil = performance.now() + 1000;
      follower.reset();
      return tr;
    },
    props: {
      handleDOMEvents: {
        compositionend: (view) => {
          follower.compositionEnd(view);
          return false;
        },
        focus: (view) => {
          if (performance.now() < resyncOnFocusUntil) {
            resyncOnFocusUntil = 0;
            view.focus();
          }
          return false;
        },
      },
      handleKeyDown: (view, event) => view.editable && keydown(view, event),
      // 选中文字粘贴 URL → 加链接;否则从代码编辑器复制来的内容按纯文本当 Markdown 解析(不用随附的高亮 HTML;见 milkdown-paste)
      handlePaste: (view, event) => pasteUrlAsLink(ctx, view, event) || pasteEditorCopyAsMarkdown(ctx, view, event),
    },
  });
}

/**
 * 排在所有 ProseMirror 插件最前(不用 $prose:它追加到末尾,粘贴会先被剪贴板插件按 Markdown 解析替换掉选区;
 * 表格 Tab 也须先于缩进插件)。
 */
export const markdownWritingKeys: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(SchemaReady);
  const plugin = createWritingKeysPlugin(ctx);
  ctx.update(prosePluginsCtx, (ps) => [plugin, ...ps]);
  return () => ctx.update(prosePluginsCtx, (ps) => ps.filter((p) => p !== plugin));
};
