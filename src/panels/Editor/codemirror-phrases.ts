// CodeMirror 内建 UI 文案(⌘F 查找 / 替换面板、跳转行、折叠提示)随界面语言显示 —— 对齐 VSCode:查找控件跟随显示语言。
// CodeMirror 经 EditorState.phrases facet 翻译内建文案(state.phrase(英文原文) → 译文);这里把原文映射到 catalog key,
// 按当前语言生成 facet 值。CodeEditor 放进 Compartment、语言切换时 reconfigure;Markdown 代码块(Crepe 的 CodeMirror,
// 同样带 basicSetup 查找面板)随 Provider 的 locale key 重挂,创建时取当前语言即可。
// BDD: src/__tests__/editor-find-i18n/

import { EditorState, type Extension } from '@codemirror/state';
import { t, type TranslationKey } from '@/i18n';

/** CodeMirror 原文 → catalog key。键集覆盖 @codemirror/search 的全部 phrase(BDD 从已安装包源码核对)+ 折叠提示。 */
export const CODEMIRROR_PHRASE_KEYS: Readonly<Record<string, TranslationKey>> = {
  // @codemirror/search:查找 / 替换面板
  Find: 'editor.cm.find',
  Replace: 'editor.cm.replace',
  next: 'editor.cm.next',
  previous: 'editor.cm.previous',
  all: 'editor.cm.all',
  'match case': 'editor.cm.match_case',
  regexp: 'editor.cm.regexp',
  'by word': 'editor.cm.by_word',
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
