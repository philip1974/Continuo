// CodeEditor(代码文件 + Markdown Source 模式)的外观。
//
// 编辑器外观(背景 / gutter / 当前行 / 选区 / 光标 / 字体)一套 EditorView.theme 同时用于亮 / 暗:全部取
// 设计 token(--md-* / --wm-font-mono),随 <html class="dark"> 切换自动变色,与画布 / 终端 / Markdown
// 编辑器同底色。此前暗色直接用 oneDark(底色 #282c34 与 --md-surface #11131b 割裂),亮色用 CodeMirror
// 默认主题(标题粗体加下划线、gutter #f5f5f5)。
//
// 语法高亮:一套 HighlightStyle 取 theme.css 的 --md-syntax-* 槽位(暗色 = oneDark 原值,亮色 = One Light 色相
// 加深到 AA),标题只加粗不加下划线。
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const SELECTION = 'color-mix(in srgb, var(--md-primary) 28%, transparent)';

/** 编辑器外观(亮 / 暗共用,全部走 token)。`dark` 只影响 CodeMirror 内建样式选亮 / 暗变体。 */
function chromeTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': { backgroundColor: 'var(--md-surface)', color: 'var(--md-on-surface)' },
      '.cm-scroller': { fontFamily: 'var(--wm-font-mono)' },
      '.cm-content': { caretColor: 'var(--md-on-surface)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--md-on-surface)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: SELECTION },
      '.cm-activeLine': { backgroundColor: 'var(--md-state-hover)' },
      '.cm-gutters': {
        backgroundColor: 'var(--md-surface)',
        color: 'var(--md-fg-dim)',
        border: 'none',
      },
      '.cm-activeLineGutter': { backgroundColor: 'var(--md-state-hover)', color: 'var(--md-on-surface-variant)' },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--md-surface-container-high)',
        border: 'none',
        color: 'var(--md-on-surface-variant)',
      },
      '.cm-searchMatch': {
        backgroundColor: 'color-mix(in srgb, var(--md-warning) 30%, transparent)',
        outline: '1px solid color-mix(in srgb, var(--md-warning) 60%, transparent)',
      },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: SELECTION },
      '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--md-primary) 14%, transparent)' },
      '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
        backgroundColor: 'color-mix(in srgb, var(--md-primary) 22%, transparent)',
      },
      '.cm-panels': { backgroundColor: 'var(--md-surface-container)', color: 'var(--md-on-surface)' },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--md-outline-variant)' },
      '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--md-outline-variant)' },
      '.cm-tooltip': {
        border: '1px solid var(--md-outline-variant)',
        backgroundColor: 'var(--md-surface-container)',
        color: 'var(--md-on-surface)',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'var(--md-surface-container-highest)',
        color: 'var(--md-on-surface)',
      },
    },
    { dark },
  );
}

// 语法高亮:一套 HighlightStyle,颜色全取 theme.css 的 --md-syntax-*(light / dark 各一套值),切主题靠
// <html class="dark"> 即时生效。tag 分组沿用 oneDark;标题只加粗不加下划线。
const codeHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--md-syntax-keyword)' },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: 'var(--md-syntax-name)' },
  { tag: [t.function(t.variableName), t.labelName], color: 'var(--md-syntax-function)' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: 'var(--md-syntax-constant)' },
  { tag: [t.definition(t.name), t.separator], color: 'var(--md-syntax-definition)' },
  {
    tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace],
    color: 'var(--md-syntax-type)',
  },
  {
    tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.special(t.string)],
    color: 'var(--md-syntax-operator)',
  },
  { tag: [t.meta, t.comment], color: 'var(--md-syntax-comment)', fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--md-syntax-link)', textDecoration: 'underline' },
  { tag: t.heading, fontWeight: 'bold', color: 'var(--md-syntax-heading)' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: 'var(--md-syntax-constant)' },
  { tag: [t.processingInstruction, t.string, t.inserted], color: 'var(--md-syntax-string)' },
  { tag: t.invalid, color: 'var(--md-syntax-invalid)' },
]);

const HIGHLIGHT: Extension = syntaxHighlighting(codeHighlightStyle);
const DARK: Extension = [chromeTheme(true), HIGHLIGHT];
const LIGHT: Extension = [chromeTheme(false), HIGHLIGHT];

export function codeEditorTheme(resolved: 'light' | 'dark'): Extension {
  return resolved === 'dark' ? DARK : LIGHT;
}
