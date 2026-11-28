// CodeEditor(代码文件 + Markdown Source 模式)的外观。
//
// 编辑器外观(背景 / gutter / 当前行 / 选区 / 光标 / 字体)一套 EditorView.theme 同时用于亮 / 暗:全部取
// 设计 token(--md-* / 字体取 editor.fontFamily 的 --wm-editor-font-family,缺省 --wm-font-mono),随 <html class="dark"> 切换自动变色,与画布 / 终端 / Markdown
// 编辑器同底色。此前暗色直接用 oneDark(底色 #282c34 与 --md-surface #11131b 割裂),亮色用 CodeMirror
// 默认主题(标题粗体加下划线、gutter #f5f5f5)。
//
// 语法高亮:一套 HighlightStyle 取 theme.css 的 --md-syntax-* 槽位(暗色 = oneDark 原值,亮色 = One Light 色相
// 加深到 AA),标题只加粗不加下划线。
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { codeMirrorFind } from './codemirror-find';
import { isDarkTheme, type ResolvedTheme } from '../../../electron/shared/window-background';

/** 选区底:theme.css 的 --md-editor-selection(两主题各取值,保证注释 / 关键字等语法色叠选区后的对比度,见该 token 注释)。 */
const SELECTION = 'var(--md-editor-selection)';
/** 查找的当前匹配:主色 28%(与 Markdown 编辑器的当前匹配同色,见 milkdown-font-override.css)。 */
const SEARCH_CURRENT = 'color-mix(in srgb, var(--md-primary) 28%, transparent)';

/** 编辑器外观(亮 / 暗共用,全部走 token)。`dark` 只影响 CodeMirror 内建样式选亮 / 暗变体。 */
function chromeTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': { backgroundColor: 'var(--md-surface)', color: 'var(--md-on-surface)' },
      // CodeMirror 基础主题给聚焦编辑器画 1px dotted #212121 轮廓;VSCode 编辑器聚焦无边框(光标 / 当前行即焦点指示)。
      // Markdown 代码块(markdownCodeBlockTheme)同用本外观。
      '&.cm-focused': { outline: 'none' },
      // 字体族 = 设置 editor.fontFamily(EditorFontFromSettings 写到 <html>;Markdown 代码块同用本外观,一并跟随)
      '.cm-scroller': { fontFamily: 'var(--wm-editor-font-family, var(--wm-font-mono))' },
      '.cm-content': { caretColor: 'var(--md-on-surface)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--md-on-surface)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: SELECTION },
      '.cm-activeLine': { backgroundColor: 'var(--md-state-hover)' },
      // 行号 / 折叠栏不参与文字选择(VSCode 同):在正文里拖选经过 gutter、或在行号上拖动选行时,行号数字不会被选中 / 复制
      '.cm-gutters': {
        backgroundColor: 'var(--md-surface)',
        color: 'var(--md-fg-dim)',
        border: 'none',
        userSelect: 'none',
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
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: SEARCH_CURRENT },
      // 强制颜色(Windows 高对比度):底色被抹成 Canvas、轮廓改 CanvasText,当前匹配与其它匹配、选区都不可辨。
      // 对齐 VSCode 高对比度主题:当前匹配 2px Highlight 实线(contrastActiveBorder),其它匹配 1px CanvasText 虚线,
      // 选区画 Highlight 轮廓(不改底色:选区层在文字下方,Highlight 底 + CanvasText 字在部分高对比度主题下对比不足)。
      '@media (forced-colors: active)': {
        '.cm-searchMatch': { outline: '1px dashed CanvasText' },
        '.cm-searchMatch.cm-searchMatch-selected': { outline: '2px solid Highlight' },
        '.cm-selectionBackground': { outline: '1px solid Highlight', outlineOffset: '-1px' },
        // 与选区相同的文本 / 光标处单词的其它出现处(VSCode HC editor.selectionHighlightBorder = contrastActiveBorder,
        // hc 主题 border-style: dotted)与匹配括号(editorBracketMatch.border = contrastBorder,实线):底色被抹掉后改画轮廓。
        '.cm-selectionMatch': { outline: '1px dotted CanvasText', outlineOffset: '-1px' },
        // (@media 块里不能写 &:EditorView.theme 会把 & 换成「@media …」,生成无效选择器)
        '.cm-matchingBracket': { outline: '1px solid CanvasText', outlineOffset: '-1px' },
        // 缩进参考线(库用 background 渐变 + 自定义属性画线):普通线 GrayText、当前块那一条 CanvasText(VSCode HC
        // editorIndentGuide.activeBackground1 比普通线更亮);forced-color-adjust: none 保住系统色渐变。颜色属性设在行元素本身
        //(行内 --indent-markers 渐变在该元素上解析 var()),不与库 baseTheme 在编辑器根上的 &light / &dark 比优先级。
        '.cm-indent-markers': { '--indent-marker-bg-color': 'GrayText', '--indent-marker-active-bg-color': 'CanvasText' },
        '.cm-indent-markers::before': { forcedColorAdjust: 'none' },
        // 查找选项 toggle 勾选态(同 forced-colors.css 的 [aria-pressed=true]:内嵌 2px Highlight 轮廓)
        '.cm-panel label.cm-search-option:has(input:checked)': { outline: '2px solid Highlight', outlineOffset: '-2px' },
      },
      '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--md-primary) 14%, transparent)' },
      '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
        backgroundColor: 'color-mix(in srgb, var(--md-primary) 22%, transparent)',
      },
      '.cm-panels': { backgroundColor: 'var(--md-surface-container)', color: 'var(--md-on-surface)' },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--md-outline-variant)' },
      '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--md-outline-variant)' },
      // ⌘F 查找 / 替换面板与跳转行面板:输入框、按钮、复选框与设计层(Input / Button)同一套 token,替代 CodeMirror
      // 默认的白底输入框 + 灰渐变按钮(亮色)/ 黑渐变按钮(暗色)。字号取界面字号而非 CodeMirror 默认的 70%。
      // color-scheme:原生复选框未勾选态按亮 / 暗绘制(否则暗色下是白方块);勾选态走 accent-color。
      '.cm-panel': { fontFamily: 'var(--wm-font-sans)', colorScheme: dark ? 'dark' : 'light' },
      '.cm-panel label': { color: 'var(--md-on-surface-variant)', fontSize: 'var(--wm-text-xs)' },
      '.cm-textfield': {
        backgroundColor: 'var(--md-surface-container-low)',
        color: 'var(--md-on-surface)',
        // 输入框描边同 design Input(--md-outline,控件边界 ≥ 3:1)
        border: '1px solid var(--md-outline)',
        borderRadius: '4px',
        padding: '2px 6px',
        fontFamily: 'var(--wm-font-sans)',
        fontSize: 'var(--wm-text-sm)',
        outline: 'none',
      },
      '.cm-textfield:focus': { borderColor: 'var(--md-focus-ring)', backgroundColor: 'var(--md-surface-container)' },
      // 占位文字同 design Input(--md-fg-dim:亮色 outline 在 container-low 上只有 4.14:1)
      '.cm-textfield::placeholder': { color: 'var(--md-fg-dim)' },
      // 查找无结果(codemirror-find.ts 置 aria-invalid):错误色描边,聚焦再加 1px 错误色环 —— 同 design Input 的校验失败态
      // (VSCode inputValidation.errorBorder)。
      '.cm-textfield[aria-invalid="true"], .cm-textfield[aria-invalid="true"]:focus': { borderColor: 'var(--md-error)' },
      '.cm-textfield[aria-invalid="true"]:focus': { boxShadow: '0 0 0 1px var(--md-error)' },
      // 匹配计数「3 / 154」(VSCode 查找框右侧的 matchesCount);「无结果」用错误色。
      '.cm-search-count': {
        display: 'inline-block',
        minWidth: '5em',
        margin: '.2em .6em .2em 0',
        color: 'var(--md-fg-dim)',
        fontSize: 'var(--wm-text-xs)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      '.cm-search-count[data-no-results]': { color: 'var(--md-error)' },
      '.cm-button': {
        backgroundImage: 'none',
        backgroundColor: 'var(--md-surface-container-high)',
        color: 'var(--md-on-surface)',
        border: '1px solid var(--md-outline-variant)',
        borderRadius: '4px',
        padding: '2px 8px',
        fontFamily: 'var(--wm-font-sans)',
        fontSize: 'var(--wm-text-xs)',
        cursor: 'pointer',
      },
      '.cm-button:hover, .cm-button:active': {
        backgroundImage: 'linear-gradient(var(--md-state-hover), var(--md-state-hover))',
      },
      '.cm-panel input[type=checkbox]': { accentColor: 'var(--md-primary)', cursor: 'pointer' },
      // 查找选项 toggle(codemirror-find 把复选框排成 Aa / ab / .*):外观同 design IconButton xs(20px 方块、按下态同
      // .wm-icon-button[aria-pressed=true]),原生复选框透明铺满 label(仍可点 / 空格 / Tab 聚焦),选项名视觉隐藏。
      '.cm-search-options': { display: 'inline-flex', alignItems: 'center', gap: '2px', margin: '0 .4em 0 0', verticalAlign: 'middle' },
      '.cm-panel label.cm-search-option': {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '20px',
        height: '20px',
        borderRadius: '4px',
        color: 'var(--md-on-surface-variant)',
        fontSize: '11px',
        lineHeight: '1',
        cursor: 'pointer',
      },
      '.cm-panel label.cm-search-option:hover': {
        backgroundColor: 'var(--md-state-hover)',
        color: 'var(--md-on-surface)',
      },
      '.cm-panel label.cm-search-option:has(input:checked)': {
        backgroundColor: 'color-mix(in srgb, var(--md-primary) 20%, transparent)',
        color: 'var(--md-on-surface)',
        boxShadow: 'inset 0 0 0 1px var(--md-primary)',
      },
      '.cm-panel label.cm-search-option input[type=checkbox]': {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        margin: '0',
        opacity: '0',
        cursor: 'pointer',
      },
      '.cm-panel label.cm-search-option:has(input:focus-visible)': {
        outline: '2px solid var(--md-focus-ring)',
        outlineOffset: '1px',
      },
      '.cm-search-option-name': {
        position: 'absolute',
        width: '1px',
        height: '1px',
        overflow: 'hidden',
        clip: 'rect(0 0 0 0)',
        whiteSpace: 'nowrap',
      },
      '.cm-panel button[name=close]': { color: 'var(--md-on-surface-variant)', cursor: 'pointer' },
      '.cm-panel button[name=close]:hover': { color: 'var(--md-on-surface)' },
      '.cm-button:focus-visible, .cm-panel input[type=checkbox]:focus-visible, .cm-panel button[name=close]:focus-visible': {
        outline: '2px solid var(--md-focus-ring)',
        outlineOffset: '1px',
      },
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

/** 高对比度两套按明暗取变体;HC 专有的边框(当前行 / 选区 / 匹配等)在 src/styles/high-contrast.css。 */
export function codeEditorTheme(resolved: ResolvedTheme): Extension {
  return isDarkTheme(resolved) ? DARK : LIGHT;
}

/**
 * Markdown 编辑模式(Crepe)代码块的 CodeMirror 主题。Crepe 不传 theme 时默认 oneDark,亮色主题下仍是深色配色。
 * 代码块底色 / gutter 由 Crepe CSS 按 --crepe-color-surface 绘制(选择器更具体,压过这里的外观),这里只需同一套
 * token 外观(光标 / 选区 / 当前行 / 面板)+ --md-syntax-* 语法色 —— 全部随 <html class="dark"> 变色,与 resolved
 * 无关,故亮 / 暗共用这一个扩展,切主题不必重挂编辑器。不声明 dark:内建样式的亮 / 暗变体都被上面的 token 规则覆盖。
 * 代码块同样带 basicSetup 的 ⌘F 面板:一并挂上查找补强(计数 / 无结果 / 快捷键 / 历史,与 CodeEditor 同一个扩展常量)。
 */
export const markdownCodeBlockTheme: Extension = [LIGHT, codeMirrorFind];
