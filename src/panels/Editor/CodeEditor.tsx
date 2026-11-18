// M-Editor Step E3:CodeMirror 6 包装。
// 从 MindAutonAgent CodeEditor.tsx 移植,语言映射一致(js/ts/json/css/html/md)。
//
// 用途:
//   1. 非 markdown 文件(.js/.json/...)的代码编辑
//   2. markdown 的 Source mode(决策 #4:用 CodeMirror markdown 模式,
//      比 Mind 原版 textarea 强,有语法高亮 + 折叠)
//
// 主题:dark 模式用 oneDark,light 模式用 basicSetup 自带浅色默认。
// 通过 Compartment.reconfigure 热切,无需重建 EditorView。

import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { useSettingValue } from '@/plugins/settings/values-store';
import { useEditorStore } from '@/stores/editor.store';
import { useTheme } from '@/theme';
import { debugDecorationsExtension } from './decorations/debug-decorations';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';

interface CodeEditorProps {
  tabId: string;
  value: string;
  onChange?: (value: string) => void;
  readonly?: boolean;
  fileName?: string;
  /** 强制语言(高于 fileName 推断;Source mode 用 'markdown'). */
  forceLanguage?: 'markdown' | 'javascript' | 'typescript' | 'json' | 'css' | 'html';
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
const EMPTY_THEME_EXTENSIONS: Extension[] = [];

function pickThemeExtension(resolved: string): Extension {
  return resolved === 'dark' ? oneDark : EMPTY_THEME_EXTENSIONS;
}

export function pickLanguage(
  fileName: string,
  forceLanguage?: CodeEditorProps['forceLanguage'],
): Extension {
  if (forceLanguage) {
    switch (forceLanguage) {
      case 'markdown':
        return markdown();
      case 'javascript':
        return javascript({ jsx: true });
      case 'typescript':
        return javascript({ jsx: true, typescript: true });
      case 'json':
        return json();
      case 'css':
        return css();
      case 'html':
        return html();
    }
  }
  const ext = fileExtensionLower(fileName);
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: true });
    case 'ts':
    case 'tsx':
      return javascript({ jsx: true, typescript: true });
    case 'json':
      return json();
    case 'css':
      return css();
    case 'html':
    case 'htm':
      return html();
    case 'md':
    case 'markdown':
      return markdown();
    default:
      return EMPTY_LANGUAGE_EXTENSIONS;
  }
}

export function CodeEditor({
  tabId,
  value,
  onChange,
  readonly = false,
  fileName = '',
  forceLanguage,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const langCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
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

  // 创建 editor 一次,父用 key={tabId} 强制 remount 切 tab
  useEffect(() => {
    if (!containerRef.current) return;
    const lang = pickLanguage(fileName, forceLanguage);
    const themeExt = pickThemeExtension(resolved);
    appliedLangKeyRef.current = `${fileName}\u0000${forceLanguage ?? ''}`;
    appliedThemeRef.current = resolved;
    eolRef.current = detectLineEnding(value);

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        themeCompartment.current.of(themeExt),
        langCompartment.current.of(lang),
        debugDecorationsExtension(),
        EditorView.editable.of(!readonly),
        EditorState.readOnly.of(readonly),
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
          '.cm-scroller': {
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
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
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;
    useEditorStore.getState().registerView(tabId, view);

    return () => {
      useEditorStore.getState().unregisterView(tabId, view);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // fileName 或 forceLanguage 变化 → 重配置 language
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const key = `${fileName}\u0000${forceLanguage ?? ''}`;
    if (appliedLangKeyRef.current === key) return;
    appliedLangKeyRef.current = key;
    view.dispatch({
      effects: langCompartment.current.reconfigure(
        pickLanguage(fileName, forceLanguage),
      ),
    });
  }, [fileName, forceLanguage]);

  // 主题切换 → 热替换 oneDark / 浅色默认,避免重建 editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (appliedThemeRef.current === resolved) return;
    appliedThemeRef.current = resolved;
    const themeExt = pickThemeExtension(resolved);
    view.dispatch({
      effects: themeCompartment.current.reconfigure(themeExt),
    });
  }, [resolved]);

  // 外层 div 设 fontSize,内部 .cm-editor / .cm-content / .cm-gutters
  // 都 inherit。改 settings 字号 → React 重渲外层 → CodeMirror 立即跟新。
  const fontSize = useSettingValue<number>('editor.fontSize', 13);
  const lineNumbers = useSettingValue<boolean>('editor.lineNumbers', true);

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
