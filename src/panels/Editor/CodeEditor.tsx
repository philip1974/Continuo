// M-Editor Step E3:CodeMirror 6 包装。
// 从 MindAutonAgent CodeEditor.tsx 移植,语言映射一致(js/ts/json/css/html/md)。
//
// 用途:
//   1. 非 markdown 文件(.js/.json/...)的代码编辑
//   2. markdown 的 Source mode(决策 #4:用 CodeMirror markdown 模式,
//      比 Mind 原版 textarea 强,有语法高亮 + 折叠)
//
// 主题:固定 oneDark(LayoutMotion 项目主题色)。无需 useTheme 切换。

import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';

interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readonly?: boolean;
  fileName?: string;
  /** 强制语言(高于 fileName 推断;Source mode 用 'markdown'). */
  forceLanguage?: 'markdown' | 'javascript' | 'typescript' | 'json' | 'css' | 'html';
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
  const ext = fileName.split('.').pop()?.toLowerCase();
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
  const suppressNextChange = useRef(false);

  // 创建 editor 一次,父用 key={tabId} 强制 remount 切 tab
  useEffect(() => {
    if (!containerRef.current) return;
    const lang = pickLanguage(fileName, forceLanguage);

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        oneDark,
        langCompartment.current.of(lang),
        EditorView.editable.of(!readonly),
        EditorState.readOnly.of(readonly),
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (
            update.docChanged &&
            !suppressNextChange.current &&
            onChangeRef.current
          ) {
            onChangeRef.current(update.state.doc.toString());
          }
          suppressNextChange.current = false;
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': {
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            overflow: 'auto',
          },
          '.cm-content': { padding: '12px 0' },
          '.cm-gutters': { border: 'none' },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value 变化(rare:同 tab 内程序化改 content)→ 同步到 editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === value) return;
    suppressNextChange.current = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
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

  return <div ref={containerRef} className="h-full w-full" />;
}
