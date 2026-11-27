// @vitest-environment jsdom
// BDD: editor-wrapping-indent —— 自动换行的续行与首行缩进对齐(VSCode editor.wrappingIndent 默认 same)。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';

vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { wrappedIndentColumns } from '../../panels/Editor/codemirror-wrapping-indent';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';
import { setTabIndentation, useIndentationStore } from '../../panels/Editor/editor-indentation';
import { EDITOR_WORD_WRAP } from '../../plugins/settings/core-setting-specs';

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'source' });
  useSettingsValuesStore.setState({ values: { [EDITOR_WORD_WRAP.id]: true } });
  useIndentationStore.setState({ byTab: new Map() });
});
afterEach(() => {
  useEditorStore.setState({ tabs: [] });
  cleanup();
});

function open(p: string, content: string, forceLanguage?: 'markdown'): EditorView {
  useEditorStore.getState().openTab(createTab(p, content));
  render(<CodeEditor tabId={p} value={content} fileName={p.slice(p.lastIndexOf('/') + 1)} forceLanguage={forceLanguage} />);
  return useEditorStore.getState().viewRefs.get(p) as EditorView;
}

const lineEl = (view: EditorView, n: number) => view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')[n - 1]!;
/** 第 n 行的悬挂缩进列数(无 → 0)。 */
function hanging(view: EditorView, n: number): number {
  const el = lineEl(view, n);
  if (!el.classList.contains('cm-wrap-indent')) return 0;
  const style = el.getAttribute('style') ?? '';
  const m = /padding-left: calc\((?:6px \+ (\d+)ch|(\d+)ch \+ 6px)\)/.exec(style);
  const pad = m?.[1] ?? m?.[2];
  const indent = /text-indent: -(\d+)ch/.exec(style)?.[1];
  expect(pad).toBe(indent); // 首行位置不变:加多少减多少
  return Number(pad);
}

const LONG = 'x'.repeat(200);
const TS = `function f() {\n    if (x) {\n        const s = '${LONG}';\n    }\n    \n}\n`;

describe('续行缩进列数(VSCode computeWrappedTextIndentLength, wrappingIndent: same)', () => {
  it('空格 1 列;tab 跳到下一个 tabSize 倍数列;混合按顺序折算', () => {
    expect(wrappedIndentColumns('        return', 4, Infinity)).toBe(8);
    expect(wrappedIndentColumns('\t\treturn', 4, Infinity)).toBe(8);
    expect(wrappedIndentColumns('  \treturn', 4, Infinity)).toBe(4);
    expect(wrappedIndentColumns('\t  return', 8, Infinity)).toBe(10);
  });

  it('顶格行与整行空白的行不缩进', () => {
    expect(wrappedIndentColumns('return', 4, Infinity)).toBe(0);
    expect(wrappedIndentColumns('        ', 4, Infinity)).toBe(0);
    expect(wrappedIndentColumns('', 4, Infinity)).toBe(0);
  });

  it('缩进 + 一个全角字符(2 列)放不下 → 退回不缩进', () => {
    expect(wrappedIndentColumns('        x', 4, 10)).toBe(8);
    expect(wrappedIndentColumns('        x', 4, 9.9)).toBe(0);
    expect(wrappedIndentColumns(`${' '.repeat(40)}x`, 4, 30)).toBe(0);
  });
});

describe('自动换行的续行缩进', () => {
  it('开自动换行:有缩进的行按行首空白悬挂缩进,顶格行 / 空白行不加', () => {
    const view = open('/w/a.ts', TS);
    expect(hanging(view, 1)).toBe(0);
    expect(hanging(view, 2)).toBe(4);
    expect(hanging(view, 3)).toBe(8);
    expect(hanging(view, 5)).toBe(0); // 只有空白
  });

  it('关自动换行 → 即时去掉(同一视图);再开恢复', () => {
    const view = open('/w/a.ts', TS);
    act(() => useSettingsValuesStore.getState().setValue(EDITOR_WORD_WRAP.id, false));
    expect(useEditorStore.getState().viewRefs.get('/w/a.ts')).toBe(view);
    expect(view.contentDOM.querySelectorAll('.cm-wrap-indent')).toHaveLength(0);
    act(() => useSettingsValuesStore.getState().setValue(EDITOR_WORD_WRAP.id, true));
    expect(hanging(view, 3)).toBe(8);
  });

  it('默认不换行时不加', () => {
    useSettingsValuesStore.setState({ values: {} });
    const view = open('/w/a.ts', TS);
    expect(view.contentDOM.querySelectorAll('.cm-wrap-indent')).toHaveLength(0);
  });

  it('tab 缩进按 tabSize 折算;改 tab 宽度即时重算', () => {
    const view = open('/w/c.go', `func f() {\n\t\ts := "${LONG}"\n}\n`);
    act(() => setTabIndentation('/w/c.go', { tabSize: 4, insertSpaces: false }));
    expect(hanging(view, 2)).toBe(8);
    act(() => setTabIndentation('/w/c.go', { tabSize: 2, insertSpaces: false }));
    expect(hanging(view, 2)).toBe(4);
  });

  it('编辑后随行首空白更新', () => {
    const view = open('/w/a.ts', TS);
    act(() => view.dispatch({ changes: { from: view.state.doc.line(3).from, insert: '  ' } }));
    expect(hanging(view, 3)).toBe(10);
  });

  it('Markdown 源码模式同样生效', () => {
    const view = open('/w/n.md', `- a\n    - ${LONG}\n`, 'markdown');
    expect(hanging(view, 2)).toBe(4);
  });
});
