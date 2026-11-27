// Markdown 编辑模式(Milkdown)的写作按键(BDD: src/__tests__/editor-markdown-writing-keys/):
//  - 选中文字后粘贴单个 URL → 给选区加链接(VSCode markdown.editor.pasteUrlAsFormattedLink;Typora / Obsidian 同),
//    而不是用 URL 替换选中文字。
//  - ⌘K / Ctrl+K → 打开 Crepe 的链接编辑框(Typora / Obsidian):光标 / 选区在链接里 → 编辑该链接地址;否则给选区加链接
//   (没有选区 → 插入地址本身作链接文字)。按键落在 ProseMirror 里由这里处理并 preventDefault,全局「清除终端」(mac ⌘K,
//    只作用于终端)不再收到(useCommandHotkeys 对编辑器里已处理的键让行)。
//  - 表格里 Tab:下一格;最后一格 → 在表格末尾加一行并进入其首格(不再由缩进插件在格内插 4 个空格)。⇧Tab:上一格;首格 → 不动。

import { linkTooltipAPI } from '@milkdown/kit/component/link-tooltip';
import { linkSchema } from '@milkdown/kit/preset/commonmark';
import { addRowWithAlignment } from '@milkdown/kit/preset/gfm';
import { prosePluginsCtx, SchemaReady } from '@milkdown/kit/core';
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx';
import { keydownHandler } from '@milkdown/kit/prose/keymap';
import type { Mark, MarkType } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state';
import { goToNextCell, isInTable, selectedRect } from '@milkdown/kit/prose/tables';
import type { EditorView } from '@milkdown/kit/prose/view';

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

const writingKeysKey = new PluginKey('continuoMarkdownWritingKeys');

function createWritingKeysPlugin(ctx: Ctx): Plugin {
  const keydown = keydownHandler({
    'Mod-k': (_state, _dispatch, view) => (view ? openLinkEditor(ctx, view) : false),
    Tab: (state, dispatch, view) => tableTab(ctx, 1, state, dispatch, view),
    'Shift-Tab': (state, dispatch, view) => tableTab(ctx, -1, state, dispatch, view),
  });
  return new Plugin({
    key: writingKeysKey,
    props: {
      handleKeyDown: (view, event) => view.editable && keydown(view, event),
      handlePaste: (view, event) => {
        if (!view.editable) return false;
        const { selection } = view.state;
        if (selection.empty || !(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)) return false;
        const data = event.clipboardData;
        if (!data || data.files.length > 0) return false;
        const url = pastedUrl(data.getData('text/plain'));
        if (!url || inCode(view.state)) return false;
        const type = linkSchema.type(ctx);
        view.dispatch(view.state.tr.addMark(selection.from, selection.to, type.create({ href: url })).scrollIntoView());
        return true;
      },
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
