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
  return fileName.slice(idx + 1).toLowerCase();
}

function pickLanguage(fileName: string, forceLanguage?: CodeEditorProps['forceLanguage']) {
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
      return [];
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
  const { resolved } = useTheme();

  // 创建 editor 一次,父用 key={tabId} 强制 remount 切 tab
  useEffect(() => {
    if (!containerRef.current) return;
    const lang = pickLanguage(fileName, forceLanguage);
    const themeExt: Extension = resolved === 'dark' ? oneDark : [];

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        themeCompartment.current.of(themeExt),
        langCompartment.current.of(lang),
        EditorView.editable.of(!readonly),
        EditorState.readOnly.of(readonly),
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (
            update.docChanged &&
            !suppressNextChange.current &&
            onChangeRef.current
          ) {
            const next = update.state.doc.toString();
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
          // 16px 给视觉呼吸,无 gutter 时(lineNumbers=false)整体往内缩。
          '.cm-content': { padding: '12px 16px', fontSize: 'inherit' },
          '.cm-gutters': { border: 'none', fontSize: 'inherit' },
          // editor.lineNumbers=false 时:.cm-editor 加 .cm-no-gutters,
          // 整列 gutters(行号 + fold marker)隐藏。开关由 useEffect 同步到 dom.classList
          '&.cm-no-gutters .cm-gutters': { display: 'none' },
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
    const cur = view.state.doc.toString();
    if (cur === value) {
      lastSyncedValueRef.current = value; // 实际相等但 ref 滞后:对齐,后续回声免 toString
      return;
    }
    suppressNextChange.current = true;
    // 保留光标/选区:全文替换不带 selection 时 CodeMirror 会把光标甩到文档边界,用户
    // 正在文件中部阅读/定位时被外部修改打断会跳回顶部。把旧 selection clamp 到新长度后
    // 一并 dispatch;scrollIntoView 默认 false,不主动拽动滚动。见第十五轮 P2-AQ。
    const oldSel = view.state.selection.main;
    const newLen = value.length;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
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
    const themeExt: Extension = resolved === 'dark' ? oneDark : [];
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
