// 常用文本编辑命令(对齐 VSCode 的命令 id、英文标题、默认键),作用于触发窗口编辑器组的活动 CodeMirror 视图。
// - 按键:这些键已从 CodeMirror 键表去掉(codemirror-basic-setup),统一经命令注册表分发 → 快捷键页可改键 / 解绑;
//   `when: 'editorTextFocus'` 限定按键落在代码编辑器正文里才执行(终端 / 输入框 / Milkdown 代码块里照常)。
// - 执行:命令 id → CodeMirror 命令的实现在引擎 chunk(codemirror-text-commands,CodeEditor 挂载时登记);本模块在启动路径上
//   (EditorPlugin 注册命令),不静态引入编辑器引擎。有活动文本视图时它必已登记。
// - 没有文本编辑器(无 tab / 图片 / Markdown 编辑·预览模式)→ 静默;「查找」/「查找下一个·上一个」在 Markdown 编辑·预览里转给其查找条。
// BDD: src/__tests__/editor-text-commands/

import type { EditorView } from '@codemirror/view';
import { groupActiveTabIdOf, liveEditorViewOf, useEditorStore } from '@/stores/editor.store';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import type { Platform } from '@/plugins/command-palette/format-hotkey';
import type { CommandWhen } from '@/lib/editor-text-focus';
import { commandEditorGroupId } from './editor-groups-actions';
import { markdownFindOf } from './markdown-find-registry';

interface TextCommandDef {
  readonly id: string;
  /** i18n key 后缀:commands.editor.text.<key>.title */
  readonly key: string;
  readonly title: string;
  /** mac 默认键(无 = 不给默认键)。 */
  readonly mac?: string;
  /** Windows / Linux 默认键(缺省同 mac)。 */
  readonly other?: string;
  /** mac 的附加默认键(VSCode mac secondary)。 */
  readonly macAlso?: string;
  /** 上下文条件(缺省 editorTextFocus;查找类为 editorFocus —— 查找面板里同样生效,VSCode 同)。 */
  readonly when?: CommandWhen;
}

/** 命令表(VSCode 默认键:mac / Windows;查找下一个 / 上一个在 mac 另有 F3 / ⇧F3,其余每个命令一个默认键)。 */
export const EDITOR_TEXT_COMMANDS: readonly TextCommandDef[] = [
  { id: 'editor.action.commentLine', key: 'comment_line', title: 'Toggle Line Comment', mac: 'mod+/' },
  { id: 'editor.action.blockComment', key: 'block_comment', title: 'Toggle Block Comment', mac: 'shift+alt+a' },
  { id: 'editor.action.moveLinesUpAction', key: 'move_lines_up', title: 'Move Line Up', mac: 'alt+up' },
  { id: 'editor.action.moveLinesDownAction', key: 'move_lines_down', title: 'Move Line Down', mac: 'alt+down' },
  { id: 'editor.action.copyLinesUpAction', key: 'copy_lines_up', title: 'Copy Line Up', mac: 'shift+alt+up' },
  { id: 'editor.action.copyLinesDownAction', key: 'copy_lines_down', title: 'Copy Line Down', mac: 'shift+alt+down' },
  { id: 'editor.action.deleteLines', key: 'delete_lines', title: 'Delete Line', mac: 'mod+shift+k' },
  { id: 'editor.action.insertLineAfter', key: 'insert_line_after', title: 'Insert Line Below', mac: 'mod+enter' },
  // ⇧⌘Enter 与「切换终端缩放」同键:本命令只在编辑器正文获焦时胜出(when),终端里仍是缩放
  { id: 'editor.action.insertLineBefore', key: 'insert_line_before', title: 'Insert Line Above', mac: 'mod+shift+enter' },
  { id: 'editor.action.indentLines', key: 'indent_lines', title: 'Indent Line', mac: 'mod+]' },
  { id: 'editor.action.outdentLines', key: 'outdent_lines', title: 'Outdent Line', mac: 'mod+[' },
  {
    id: 'editor.action.addSelectionToNextFindMatch',
    key: 'add_next_match',
    title: 'Add Selection to Next Find Match',
    mac: 'mod+d',
  },
  {
    id: 'editor.action.selectHighlights',
    key: 'select_highlights',
    title: 'Select All Occurrences of Find Match',
    mac: 'mod+shift+l',
  },
  { id: 'editor.action.insertCursorAbove', key: 'cursor_above', title: 'Add Cursor Above', mac: 'mod+alt+up', other: 'ctrl+alt+up' },
  {
    id: 'editor.action.insertCursorBelow',
    key: 'cursor_below',
    title: 'Add Cursor Below',
    mac: 'mod+alt+down',
    other: 'ctrl+alt+down',
  },
  { id: 'expandLineSelection', key: 'expand_line_selection', title: 'Expand Line Selection', mac: 'mod+l' },
  { id: 'editor.fold', key: 'fold', title: 'Fold', mac: 'mod+alt+[', other: 'ctrl+shift+[' },
  { id: 'editor.unfold', key: 'unfold', title: 'Unfold', mac: 'mod+alt+]', other: 'ctrl+shift+]' },
  // VSCode 为 ⌘K ⌘0 / ⌘K ⌘J 和弦;键位模型不支持和弦 → 不给默认键,只进命令面板(可自行绑定)
  { id: 'editor.foldAll', key: 'fold_all', title: 'Fold All' },
  { id: 'editor.unfoldAll', key: 'unfold_all', title: 'Unfold All' },
  { id: 'editor.action.jumpToBracket', key: 'jump_to_bracket', title: 'Go to Bracket', mac: 'mod+shift+\\' },
  { id: 'cursorUndo', key: 'cursor_undo', title: 'Cursor Undo', mac: 'mod+u' },
  // 查找 / 替换 / 查找下一个·上一个(VSCode actions.find ⌘F、startFindReplaceAction ⌥⌘F / Ctrl+H、nextMatchFindAction ⌘G + F3 /
  // F3、previousMatchFindAction ⇧⌘G + ⇧F3 / ⇧F3):键已从 CodeMirror 键表去掉,经注册表分发(可改键);when: editorFocus ——
  // 查找面板里同样生效(面板里再按 ⌘F 全选查找词)。Markdown 编辑 / 预览(及其查找条)里 editorFocus 同样成立,查找 / 查找下一个·
  // 上一个转给它的查找条(同一套可改键的绑定;替换不支持,静默)。BDD: src/__tests__/editor-find-keybindings/
  { id: 'actions.find', key: 'find', title: 'Find', mac: 'mod+f', when: 'editorFocus' },
  {
    id: 'editor.action.startFindReplaceAction',
    key: 'replace',
    title: 'Replace',
    mac: 'mod+alt+f',
    other: 'ctrl+h',
    when: 'editorFocus',
  },
  {
    id: 'editor.action.nextMatchFindAction',
    key: 'find_next',
    title: 'Find Next',
    mac: 'mod+g',
    macAlso: 'f3',
    other: 'f3',
    when: 'editorFocus',
  },
  {
    id: 'editor.action.previousMatchFindAction',
    key: 'find_previous',
    title: 'Find Previous',
    mac: 'mod+shift+g',
    macAlso: 'shift+f3',
    other: 'shift+f3',
    when: 'editorFocus',
  },
];

/** 命令 id → 在视图上执行(CodeMirror 命令;引擎 chunk 登记)。 */
export type TextCommandRunner = (id: string, view: EditorView) => void;

let runner: TextCommandRunner | null = null;

/** 引擎 chunk 加载后登记实现(重复登记以最后一次为准)。 */
export function registerTextCommandRunner(fn: TextCommandRunner): void {
  runner = fn;
}

/** 触发窗口的编辑器组及其活动 tab(没有 → undefined)。 */
function activeTabTarget(): { readonly groupId: string; readonly tabId: string } | undefined {
  const groupId = commandEditorGroupId();
  if (groupId === undefined) return undefined;
  const tabId = groupActiveTabIdOf(useEditorStore.getState(), groupId);
  return tabId === null ? undefined : { groupId, tabId };
}

/** 触发窗口的编辑器组里活动 tab 的 CodeMirror 视图(没有 → undefined)。 */
function activeTextView(): EditorView | undefined {
  const target = activeTabTarget();
  const view = target && liveEditorViewOf(target.tabId, target.groupId);
  return view?.dom.isConnected ? view : undefined;
}

/** 活动 tab 是 Markdown 编辑 / 预览(Milkdown)→ 查找类命令转给其查找条;其余命令(含替换)静默。 */
function runInActiveMarkdown(id: string): void {
  const target = activeTabTarget();
  const find = target && markdownFindOf(target.tabId, target.groupId);
  if (!find) return;
  if (id === 'actions.find') find.open();
  else if (id === 'editor.action.nextMatchFindAction') find.step(1);
  else if (id === 'editor.action.previousMatchFindAction') find.step(-1);
}

/**
 * 在活动文本编辑器上执行命令;焦点交回该编辑器(从命令面板执行时)。没有文本编辑器 → 静默;其中「查找」「查找下一个 / 上一个」
 * 在 Markdown 编辑 / 预览里转给其查找条(替换不支持,静默)。
 */
export function runTextCommand(id: string): void {
  const view = activeTextView();
  if (!view) {
    runInActiveMarkdown(id);
    return;
  }
  if (!runner) return;
  runner(id, view);
  // 焦点已在该编辑器里(正文,或刚打开的查找面板)→ 不动
  if (!view.dom.contains(view.dom.ownerDocument.activeElement)) view.focus();
}

export function editorTextCommandSpecs(platform: Platform): CommandSpec[] {
  return EDITOR_TEXT_COMMANDS.map((c) => {
    const hotkey = platform === 'mac' ? c.mac : (c.other ?? c.mac);
    return {
      id: c.id,
      title: c.title,
      titleKey: `commands.editor.text.${c.key}.title`,
      ...(hotkey ? { hotkey } : {}),
      ...(platform === 'mac' && c.macAlso ? { secondaryHotkeys: [c.macAlso] } : {}),
      when: c.when ?? 'editorTextFocus',
      fn: () => runTextCommand(c.id),
    };
  });
}
