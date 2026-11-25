// M-Editor Step E3:CodeMirror 6 包装。
// 从维护者早期原型的 CodeEditor 移植。语言:js/ts/json/css/html/md 同步给出,其余按 @codemirror/language-data
// 懒加载(对齐 VSCode 内置常见语言高亮;BDD: src/__tests__/code-editor-language/)。
//
// 用途:
//   1. 非 markdown 文件(.js/.json/...)的代码编辑
//   2. markdown 的 Source mode(决策 #4:用 CodeMirror markdown 模式,
//      比 Mind 原版 textarea 强,有语法高亮 + 折叠)
//
// 主题:外观走设计 token(亮 / 暗共用),语法高亮走 --md-syntax-* token(见 code-editor-theme.ts)。
// 通过 Compartment.reconfigure 热切,无需重建 EditorView。

import { useEffect, useLayoutEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState, StateEffect, type Extension } from '@codemirror/state';
import { keymap, type ViewUpdate } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { useSettingValue } from '@/plugins/settings/values-store';
import {
  EDITOR_FONT_SIZE,
  EDITOR_LINE_NUMBERS,
} from '@/plugins/settings/core-setting-specs';
import { useEditorStore } from '@/stores/editor.store';
import { useTheme } from '@/theme';
import { useLocale } from '@/i18n';
import { codeMirrorContentLabel, codeMirrorPhrases, editorContentLabel } from './codemirror-phrases';
import { debugDecorationsExtension } from './decorations/debug-decorations';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import { registerEditorRootRebind } from './editor-root-registry';
import { rebindCodeMirrorRoots } from './codemirror-root';
import { codeEditorTheme } from './code-editor-theme';
import { codeMirrorFind } from './codemirror-find';
import {
  saveCodeEditorViewState,
  saveMarkdownModeAnchor,
  snapshotCodeEditorView,
  takeCodeEditorViewState,
  takeMarkdownModeAnchor,
  type CodeEditorViewState,
} from './editor-view-state-cache';
import { registerEditorFocus } from './editor-focus-registry';
import { applySourceModeAnchor, sourceModeAnchor } from './codemirror-mode-anchor';

interface CodeEditorProps {
  tabId: string;
  value: string;
  onChange?: (value: string) => void;
  fileName?: string;
  /** 强制按 markdown 高亮(高于 fileName 推断;Markdown 的 Source mode 用). */
  forceLanguage?: 'markdown';
}

export function fileExtensionLower(fileName: string): string | undefined {
  const idx = fileName.lastIndexOf('.');
  if (idx < 0 || idx === fileName.length - 1) return undefined;
  return lowerIfNeeded(fileName.slice(idx + 1));
}

/**
 * 文件换行风格:所有换行都是 CRLF 才返回 '\r\n',否则 '\n'(LF / 混合 / 无换行)。
 *
 * CodeMirror 默认按 /\r\n?|\n/ 切行、doc.toString() 固定用 \n 拼接 → CRLF 文件一次按键后
 * 回传全文全变 LF,与读盘原文永不相等(撤销仍 dirty、保存改成 LF)。纯 CRLF 文件改为在
 * 出口用 '\r\n' 拼接(doc.sliceString(0, len, eol)),逐字节还原原文。
 *
 * 不用 EditorState.lineSeparator facet:它不影响 doc.toString(),且会让粘贴 / 拖放的 LF
 * 文本(state.toText 只按配置分隔符切)整段塞进一行。混合换行文件维持既有行为(统一为 LF)——
 * 任何单一风格拼接都改不回原文,而按 /\r\n?|\n/ 切行显示最稳。
 */
export function detectLineEnding(text: string): '\r\n' | '\n' {
  let crlf = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (text.charCodeAt(i - 1) !== 13) return '\n';
    crlf++;
  }
  // 还有孤立 \r(老 Mac 换行)也算混合
  return crlf > 0 && !/\r(?!\n)/.test(text) ? '\r\n' : '\n';
}

const EMPTY_LANGUAGE_EXTENSIONS: Extension[] = [];

/** Markdown:文首 `---` 包起来的 YAML frontmatter 按 YAML 解析(否则 `key: v\n---` 会被当成 Setext 标题)。 */
function markdownWithFrontmatter(): Extension {
  return yamlFrontmatter({ content: markdown() });
}

const jsx = () => javascript({ jsx: true });
const plainJs = () => javascript();
const ts = () => javascript({ typescript: true });
const jsonLang = () => json();
const htmlLang = () => html();

/** 同步给出的内置语言(扩展名 → 工厂;markdown 源码模式的 frontmatter 配置在此)。不在表内的交给语言表。 */
const BUILTIN_LANGUAGES = new Map<string, () => Extension>([
  // VSCode 的 JavaScript 语法在 .js 里也认 JSX(React 项目常见),.mjs / .cjs 按纯 JS。
  ['js', jsx],
  ['jsx', jsx],
  ['mjs', plainJs],
  ['cjs', plainJs],
  // .ts 不开 JSX:否则 `<T>(x: T) => x` 被当成 JSX 标签,后面整段失去高亮。
  ['ts', ts],
  ['mts', ts],
  ['cts', ts],
  ['tsx', () => javascript({ jsx: true, typescript: true })],
  // lang-json 语法不含注释:jsonc 的注释不着色,其余照常高亮(比整篇纯文本好)。
  ['json', jsonLang],
  ['jsonc', jsonLang],
  ['json5', jsonLang],
  ['css', () => css()],
  ['html', htmlLang],
  ['htm', htmlLang],
  ['md', markdownWithFrontmatter],
  ['markdown', markdownWithFrontmatter],
  ['mdx', markdownWithFrontmatter],
]);

/**
 * language-data 语言表认不出、VSCode 能高亮的常见文件 → 表内条目名。
 * Makefile:表内无 Makefile 语法,recipe 行本就是 shell,取 Shell 最接近。
 */
const FILENAME_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:dockerfile|containerfile)(?:\..+)?$|\.(?:dockerfile|containerfile)$/i, 'Dockerfile'],
  [/^\.env(?:\..+)?$/i, 'Properties files'],
  [/^\.(?:bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zshenv|zprofile|zlogin|zlogout)$|\.zsh$/i, 'Shell'],
  [/^(?:gnu)?makefile$|\.mk$/i, 'Shell'],
];

/**
 * 需按语言表(@codemirror/language-data,与 Markdown 代码块同源)懒加载的语言;同步内置语言 / 认不出 → null。
 * 先按原文件名匹配(R 的 .r / .R 等大小写敏感项),再按小写重试(.PY 同 .py)。
 */
export function languageDescriptionFor(fileName: string): LanguageDescription | null {
  const ext = fileExtensionLower(fileName);
  if (ext !== undefined && BUILTIN_LANGUAGES.has(ext)) return null;
  const base = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1);
  for (const [pattern, name] of FILENAME_ALIASES) {
    if (pattern.test(base)) return LanguageDescription.matchLanguageName(languages, name, false);
  }
  return (
    LanguageDescription.matchFilename(languages, base) ??
    LanguageDescription.matchFilename(languages, lowerIfNeeded(base))
  );
}

/** 同步可得的语言:内置语言,或语言表里已加载过的;否则(含待懒加载)纯文本。 */
export function pickLanguage(
  fileName: string,
  forceLanguage?: CodeEditorProps['forceLanguage'],
): Extension {
  if (forceLanguage === 'markdown') return markdownWithFrontmatter();
  const ext = fileExtensionLower(fileName);
  const builtin = ext === undefined ? undefined : BUILTIN_LANGUAGES.get(ext);
  if (builtin) return builtin();
  return languageDescriptionFor(fileName)?.support ?? EMPTY_LANGUAGE_EXTENSIONS;
}

/**
 * 重挂时的初始状态。上次卸载时的文档与当前内容一致 → 整份 state 复用(撤销历史在 state field 里),配置整体换成
 * 本实例的扩展(compartment / 更新监听闭包都属于新实例);两份配置共有的 state field(history、debug 装饰)保值。
 * 不一致(切走期间别处改了内容)→ 新建 state,只把旧光标 / 选区收进新文档范围(滚动由 scrollTo 快照自动收进范围)。
 */
function restoreState(
  saved: CodeEditorViewState | undefined,
  value: string,
  eol: '\r\n' | '\n',
  extensions: Extension[],
): EditorState {
  if (saved) {
    const doc = saved.state.doc;
    if (doc.sliceString(0, doc.length, eol) === value) {
      return saved.state.update({ effects: StateEffect.reconfigure.of(extensions) }).state;
    }
  }
  const state = EditorState.create({ doc: value, extensions });
  if (!saved) return state;
  const len = state.doc.length;
  const { anchor, head } = saved.state.selection.main;
  return EditorState.create({
    doc: state.doc,
    selection: { anchor: Math.min(anchor, len), head: Math.min(head, len) },
    extensions,
  });
}

export function CodeEditor({
  tabId,
  value,
  onChange,
  fileName = '',
  forceLanguage,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const langCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  // 内建文案(⌘F 查找面板等)随界面语言:语言切换时 reconfigure,不重建编辑器(BDD: src/__tests__/editor-find-i18n/)。
  const phrasesCompartment = useRef(new Compartment());
  const locale = useLocale();
  const appliedLocaleRef = useRef<string | null>(null);
  // 文本区可访问名称「<文件名>，编辑器」(对齐 VSCode;BDD: src/__tests__/editor-accessible-name/):文件名(改名)/
  // 界面语言变化时 reconfigure,不重建编辑器。
  const labelCompartment = useRef(new Compartment());
  const appliedLabelRef = useRef<string | null>(null);
  const suppressNextChange = useRef(false);
  // 性能 P6:记录「editor doc 当前反映的字符串」。本地打字时 onChange emit 的值会作为
  // value 回传(受控回声),此 ref 让 value-sync effect 直接 `value === lastSynced` 跳过,
  // 连 doc.toString() 比较都省 —— 否则长文件每按键多一次 O(file) 全文拷贝。初始 = 首个
  // value(EditorState.create 用它建 doc,故 doc 一开始就反映它)。
  const lastSyncedValueRef = useRef(value);
  // 当前文件换行风格(创建时 / 外部重读时按内容判定);emit 全文用它拼接行。
  const eolRef = useRef<'\r\n' | '\n'>('\n');
  const { resolved } = useTheme();
  // 创建时已用的语言 / 主题输入:挂载时语言 / 主题 effect 也会跑一次,输入未变就不 reconfigure ——
  // markdown() 每次调用新建 Language,重配置会让整篇从 0 重新解析(每次切到 .md tab 首屏解析两遍)。
  const appliedLangKeyRef = useRef<string | null>(null);
  const appliedThemeRef = useRef<string | null>(null);

  // 语言表里的语言包尚未加载 → 先纯文本,加载完再换上。加载期间改名 / 换文件 / 卸载:语言 key 或 view 已变 →
  // 旧结果丢弃(不套到新文件上)。加载失败保持纯文本。
  const loadPendingLanguage = (view: EditorView, key: string) => {
    if (forceLanguage) return;
    const desc = languageDescriptionFor(fileName);
    if (!desc || desc.support) return;
    desc.load().then(
      (support) => {
        if (viewRef.current !== view || appliedLangKeyRef.current !== key) return;
        view.dispatch({ effects: langCompartment.current.reconfigure(support) });
      },
      () => {},
    );
  };

  // 创建 editor 一次,父用 key={tabId} 强制 remount 切 tab(视图状态经 editor-view-state-cache 按 tab 保留)
  useEffect(() => {
    if (!containerRef.current) return;
    const lang = pickLanguage(fileName, forceLanguage);
    const themeExt = codeEditorTheme(resolved);
    appliedLangKeyRef.current = `${fileName}\u0000${forceLanguage ?? ''}`;
    appliedThemeRef.current = resolved;
    appliedLocaleRef.current = locale;
    appliedLabelRef.current = editorContentLabel(fileName);
    eolRef.current = detectLineEnding(value);

    const extensions: Extension[] = [
      basicSetup,
      // Tab 缩进 / ⇧Tab 反缩进(VSCode 同)。键盘用户逃逸:Esc 后紧接着 Tab(2 秒内)交给浏览器移出焦点,
      // ⌃M(mac ⇧⌥M,basicSetup 的 toggleTabFocusMode)切换常驻模式 —— CodeMirror 内建,对应 VSCode ⌃M。
      // BDD: src/__tests__/keyboard-focus-parity/
      keymap.of([indentWithTab]),
      // ⌘F 面板补强(对齐 VSCode 查找控件):匹配计数 / 无结果、⌥⌘F 替换、⌥⌘C/W/R 切换选项、↑↓ 历史。
      // BDD: src/__tests__/editor-find-widget/
      codeMirrorFind,
      themeCompartment.current.of(themeExt),
      phrasesCompartment.current.of(codeMirrorPhrases()),
      labelCompartment.current.of(codeMirrorContentLabel(appliedLabelRef.current)),
      langCompartment.current.of(lang),
      debugDecorationsExtension(),
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (
          update.docChanged &&
          !suppressNextChange.current &&
          onChangeRef.current
        ) {
          const doc = update.state.doc;
          const next = doc.sliceString(0, doc.length, eolRef.current);
          // doc 现反映 next;记下来,value-sync effect 据此跳过本地回声(P6)。
          lastSyncedValueRef.current = next;
          onChangeRef.current(next);
        }
        suppressNextChange.current = false;
      }),
      EditorView.theme({
        // fontSize 走 inherit 从外层 div 继承,改 settings 字号无需重建 EditorView。
        // CodeMirror theme 注入的 stylesheet 中 var() 不会响应外部容器 inline
        // style 变化,所以这里用 inherit 而非 var()。
        '&': { height: '100%', fontSize: 'inherit' },
        // 字体族由 code-editor-theme 取 --wm-font-mono
        '.cm-scroller': {
          overflow: 'auto',
          fontSize: 'inherit',
        },
        // 横向 padding 16px:不让 markdown / 代码内容贴 editor 容器右边
        // (尤其中文长段无空格 wrap 时贴边格外难读);左侧 gutter 之后加
        // 16px 给视觉呼吸,无行号时(lineNumbers=false)整体往内缩。
        '.cm-content': { padding: '12px 16px', fontSize: 'inherit' },
        '.cm-gutters': { border: 'none', fontSize: 'inherit' },
        // editor.lineNumbers=false 时:.cm-editor 加 .cm-no-gutters,
        // 只隐藏 CodeMirror 自带行号/fold gutter,保留独立 debug 断点 gutter。
        '&.cm-no-gutters .cm-lineNumbers': { display: 'none !important' },
        '&.cm-no-gutters .cm-foldGutter': { display: 'none !important' },
      }),
    ];

    // 切 tab / 重命名 / 切模式后重挂:取回该 tab 上次卸载时的视图状态(BDD: src/__tests__/editor-view-state/)。
    const saved = takeCodeEditorViewState(tabId);
    // Markdown 源码视图:刚从编辑 / 预览切过来 → 滚到切换前顶部可见的源码行,光标带到原光标行(BDD: src/__tests__/markdown-mode-position/)。
    const anchor = forceLanguage === 'markdown' ? takeMarkdownModeAnchor(tabId, 'source') : undefined;
    const restored = restoreState(saved, value, eolRef.current, extensions);
    const anchored = anchor ? applySourceModeAnchor(restored, anchor) : null;
    const scrollTo = anchored?.scrollTo ?? saved?.scroll;
    const view = new EditorView({
      state: anchored?.state ?? restored,
      parent: containerRef.current,
      ...(scrollTo ? { scrollTo } : {}),
    });
    viewRef.current = view;
    useEditorStore.getState().registerView(tabId, view);
    const unregisterFocus = registerEditorFocus(tabId, () => view.focus());
    // popout 弹出 / 收回只移 DOM:按所在文档重绑 root(创建时面板 DOM 可能已不在主窗,先对齐一次)。
    const rebindRoot = () => rebindCodeMirrorRoots(view.dom);
    rebindRoot();
    const unregisterRoot = registerEditorRootRebind(rebindRoot);
    loadPendingLanguage(view, appliedLangKeyRef.current);

    return () => {
      unregisterRoot();
      unregisterFocus();
      useEditorStore.getState().unregisterView(tabId, view);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 卸载时存下视图状态供该 tab 重挂时取回。layout 清理:此时 DOM 尚未移除,滚动快照才准(passive 清理时已脱离文档)。
  // tab 已关闭 / 已改名(旧 id 不在了;改名时 store 已把状态迁到新 id)→ 不存。
  useLayoutEffect(
    () => () => {
      const view = viewRef.current;
      if (!view) return;
      const tabs = useEditorStore.getState().tabs;
      if (!tabs?.some((t) => t.id === tabId)) return;
      saveCodeEditorViewState(tabId, snapshotCodeEditorView(view));
      // 切到编辑 / 预览时据此定位(切 tab 时也记,回到源码模式本身不取用)
      if (forceLanguage === 'markdown') saveMarkdownModeAnchor(tabId, sourceModeAnchor(view));
    },
    // tabId 挂载时取定(父按 tab id 换 key 重挂)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 外部 value 变化(rare:外部进程改盘后 reloadFromDisk,或程序化改 content)→ 同步到
  // editor。正常打字走 `cur === value` early-return,不进这里。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // P6:doc 已反映该 value(本地打字回声 / 已同步过)→ 直接跳过,省一次全文 toString。
    if (value === lastSyncedValueRef.current) return;
    // 外部内容可能换了换行风格:先按新内容定风格,再比较。仅风格不同(行内容相同)时
    // 下面相等分支直接对齐,不整篇替换(后续 emit 按新风格拼接)。
    eolRef.current = detectLineEnding(value);
    const doc = view.state.doc;
    const cur = doc.sliceString(0, doc.length, eolRef.current);
    if (cur === value) {
      lastSyncedValueRef.current = value; // 实际相等但 ref 滞后:对齐,后续回声免 toString
      return;
    }
    suppressNextChange.current = true;
    // 保留光标/选区:全文替换不带 selection 时 CodeMirror 会把光标甩到文档边界,用户
    // 正在文件中部阅读/定位时被外部修改打断会跳回顶部。把旧 selection clamp 到新长度后
    // 一并 dispatch;scrollIntoView 默认 false,不主动拽动滚动。见第十五轮 P2-AQ。
    const oldSel = view.state.selection.main;
    // 新长度按文档坐标算(CRLF 在 doc 里只占 1 位;用 value.length 会越界 → RangeError)。
    const nextDoc = view.state.toText(value);
    const newLen = nextDoc.length;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: nextDoc },
      selection: {
        anchor: Math.min(oldSel.anchor, newLen),
        head: Math.min(oldSel.head, newLen),
      },
    });
    lastSyncedValueRef.current = value; // doc 现反映 value(P6)
  }, [value]);

  // 可访问名称随文件名 / 界面语言变化:与 language / phrases 的 reconfigure 合并在同一次 dispatch 里(不额外派发)。
  const labelEffects = (): StateEffect<unknown>[] => {
    const label = editorContentLabel(fileName);
    if (appliedLabelRef.current === label) return [];
    appliedLabelRef.current = label;
    return [labelCompartment.current.reconfigure(codeMirrorContentLabel(label))];
  };

  // fileName 或 forceLanguage 变化 → 重配置 language(与可访问名称)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const key = `${fileName}\u0000${forceLanguage ?? ''}`;
    if (appliedLangKeyRef.current === key) return;
    appliedLangKeyRef.current = key;
    view.dispatch({
      effects: [langCompartment.current.reconfigure(pickLanguage(fileName, forceLanguage)), ...labelEffects()],
    });
    loadPendingLanguage(view, key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName, forceLanguage]);

  // 主题切换 → 热替换亮 / 暗主题,避免重建 editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (appliedThemeRef.current === resolved) return;
    appliedThemeRef.current = resolved;
    const themeExt = codeEditorTheme(resolved);
    view.dispatch({
      effects: themeCompartment.current.reconfigure(themeExt),
    });
  }, [resolved]);

  // 界面语言切换 → 热替换内建文案(已打开的查找面板保持原文,关闭重开即新语言 —— 面板 DOM 在打开时生成)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (appliedLocaleRef.current === locale) return;
    appliedLocaleRef.current = locale;
    view.dispatch({ effects: [phrasesCompartment.current.reconfigure(codeMirrorPhrases()), ...labelEffects()] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  // 外层 div 设 fontSize,内部 .cm-editor / .cm-content / .cm-gutters
  // 都 inherit。改 settings 字号 → React 重渲外层 → CodeMirror 立即跟新。
  const fontSize = useSettingValue(EDITOR_FONT_SIZE.id, EDITOR_FONT_SIZE.default);
  const lineNumbers = useSettingValue(EDITOR_LINE_NUMBERS.id, EDITOR_LINE_NUMBERS.default);

  // editor.lineNumbers 变化 → 同步到 .cm-editor 的 className
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dom.classList.toggle('cm-no-gutters', !lineNumbers);
  }, [lineNumbers]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ fontSize: `${fontSize}px` }}
    />
  );
}
