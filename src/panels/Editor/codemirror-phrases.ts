// CodeMirror 内建 UI 文案(⌘F 查找 / 替换面板、跳转行、折叠提示)随界面语言显示 —— 对齐 VSCode:查找控件跟随显示语言。
// CodeMirror 经 EditorState.phrases facet 翻译内建文案(state.phrase(英文原文) → 译文);这里把原文映射到 catalog key,
// 按当前语言生成 facet 值。CodeEditor 放进 Compartment、语言切换时 reconfigure;Markdown 代码块(Crepe 的 CodeMirror,
// 同样带 basicSetup 查找面板)随 Provider 的 locale key 重挂,创建时取当前语言即可。
// BDD: src/__tests__/editor-find-i18n/

import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { t, type TranslationKey } from '@/i18n';
import { editorTabTitle } from './untitled';

/** CodeMirror 原文 → catalog key。键集覆盖 @codemirror/search 的全部 phrase(BDD 从已安装包源码核对)+ 折叠提示。 */
export const CODEMIRROR_PHRASE_KEYS: Readonly<Record<string, TranslationKey>> = {
  // @codemirror/search:查找 / 替换面板
  Find: 'editor.cm.find',
  Replace: 'editor.cm.replace',
  next: 'editor.cm.next',
  previous: 'editor.cm.previous',
  all: 'editor.cm.all',
  // 选项名称与在文件中查找 / 终端查找共用(src/lib/find-options)
  'match case': 'find.option.match_case',
  regexp: 'find.option.regex',
  'by word': 'find.option.whole_word',
  replace: 'editor.cm.replace_one',
  'replace all': 'editor.cm.replace_all',
  close: 'editor.cm.close',
  // @codemirror/search:跳转行(⌥G / Ctrl+Alt+G)与读屏播报
  'Go to line': 'editor.cm.go_to_line',
  go: 'editor.cm.go',
  'current match': 'editor.cm.current_match',
  'on line': 'editor.cm.on_line',
  'replaced match on line $': 'editor.cm.replaced_on_line',
  'replaced $ matches': 'editor.cm.replaced_count',
  // @codemirror/language:折叠 gutter 提示 / 折叠占位 / 读屏播报
  'Fold line': 'editor.cm.fold_line',
  'Unfold line': 'editor.cm.unfold_line',
  'folded code': 'editor.cm.folded_code',
  unfold: 'editor.cm.unfold',
  'Folded lines': 'editor.cm.folded_lines',
  'Unfolded lines': 'editor.cm.unfolded_lines',
  to: 'editor.cm.to',
};

/** 按当前界面语言生成 CodeMirror phrases 扩展。 */
export function codeMirrorPhrases(): Extension {
  const phrases: Record<string, string> = {};
  for (const [phrase, key] of Object.entries(CODEMIRROR_PHRASE_KEYS)) phrases[phrase] = t(key);
  return EditorState.phrases.of(phrases);
}

/**
 * 编辑区文本框的可访问名称(WCAG 4.1.2;对齐 VSCode 编辑器「<文件名>, Editor Group N」):「<文件名>，编辑器」,
 * 无文件名退回「编辑器」;文件名同 tab / 标题栏(editorTabTitle:无标题文件念「无标题-N」,不念内部标识);所在窗口有多个编辑器组时(group = 组号,同 dock 标题「编辑器 N」的来源)为「<文件名>，编辑器组 N」/
 *「编辑器组 N」。CodeEditor 与 Milkdown(ProseMirror)共用。BDD: src/__tests__/editor-accessible-name/
 */
export function editorContentLabel(fileName: string | undefined, group?: number): string {
  const name = fileName ? editorTabTitle(fileName) : '';
  if (group !== undefined) {
    const n = String(group);
    return name ? t('editor.aria.content_group', { name, n }) : t('editor.aria.group', { n });
  }
  return name ? t('editor.aria.content', { name }) : t('panels.editor.title');
}

/**
 * Markdown 只读预览的可访问名称(VSCode Markdown 预览名称「Preview <文件名>」):「<文件名>，预览」,无文件名退回「预览」。
 * 预览不是可编辑的编辑器,不能念成「编辑器」。BDD: src/__tests__/editor-accessible-name/
 */
export function previewContentLabel(fileName: string | undefined): string {
  const name = fileName ? editorTabTitle(fileName) : '';
  return name ? t('editor.aria.preview', { name }) : t('panels.editor.mode.preview');
}

/** CodeMirror 文本区(`.cm-content`,role=textbox)的 aria-label。 */
export function codeMirrorContentLabel(label: string): Extension {
  return EditorView.contentAttributes.of({ 'aria-label': label });
}
