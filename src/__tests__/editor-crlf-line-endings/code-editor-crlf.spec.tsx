// @vitest-environment jsdom
// CodeEditor 保留 CRLF 换行风格(见同目录 README)。
//
// 根因:CodeMirror 默认按 /\r\n?|\n/ 切行,而 doc.toString() 固定用 \n 拼接 → CRLF 文件
// 一次按键后 onChange 回传的全文全变 LF,与读盘原文 originalContent(\r\n)永不相等:
// 撤销回原样仍 dirty、关窗弹未保存、保存把整文件改成 LF。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { runScopeHandlers, type EditorView } from '@codemirror/view';

vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_k: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { createTab, useEditorStore } from '../../stores/editor.store';

const PATH = '/repo/src/a.ts';

function openAndRender(content: string) {
  useEditorStore.getState().openTab(createTab(PATH, content));
  const onChange = (v: string) => useEditorStore.getState().updateContent(PATH, v);
  const utils = render(
    <CodeEditor tabId={PATH} value={content} fileName="a.ts" onChange={onChange} />,
  );
  const view = useEditorStore.getState().viewRefs.get(PATH) as EditorView;
  expect(view).toBeTruthy();
  return { ...utils, view, onChange };
}

/** 走 basicSetup 自带的撤销快捷键(@codemirror/commands 非直接依赖,不直接 import)。 */
function undo(view: EditorView) {
  const isMac = /Mac/.test(navigator.platform);
  const ev = new KeyboardEvent('keydown', { key: 'z', metaKey: isMac, ctrlKey: !isMac });
  expect(runScopeHandlers(view, ev, 'editor')).toBe(true);
}

const tab = () => useEditorStore.getState().tabs.find((t) => t.id === PATH)!;

/** 模拟用户在第 1 行行尾打一个字符(进入撤销历史)。 */
function typeAtEndOfFirstLine(view: EditorView, ch: string) {
  const at = view.state.doc.line(1).to;
  view.dispatch({ changes: { from: at, insert: ch }, userEvent: 'input.type' });
}

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null });
});
afterEach(() => {
  cleanup();
});

describe('CodeEditor · CRLF 文件保留换行风格', () => {
  it('CRLF 文件:编辑后回传的全文仍是 CRLF(保存写盘即 CRLF)', () => {
    const { view } = openAndRender('a\r\nb\r\nc\r\n');
    typeAtEndOfFirstLine(view, 'X');
    expect(tab().content).toBe('aX\r\nb\r\nc\r\n');
    expect(tab().dirty).toBe(true);
  });

  it('CRLF 文件:改后撤销回原样 → 不再 dirty', () => {
    const { view } = openAndRender('a\r\nb\r\nc\r\n');
    typeAtEndOfFirstLine(view, 'X');
    expect(tab().dirty).toBe(true);
    undo(view);
    expect(tab().content).toBe('a\r\nb\r\nc\r\n');
    expect(tab().dirty).toBe(false);
  });

  it('CRLF 文件:回车换行插入的是 CRLF', () => {
    const { view } = openAndRender('a\r\nb');
    view.dispatch({
      changes: { from: 1, insert: view.state.lineBreak },
      userEvent: 'input',
    });
    // 无论 lineBreak 是什么,文档按行切分后再以文件风格拼接
    expect(tab().content).toBe('a\r\n\r\nb');
  });

  it('CRLF 文件:粘贴 LF 多行文本 → 正常分行并以 CRLF 落盘', () => {
    const { view } = openAndRender('a\r\nb');
    view.dispatch({
      changes: { from: 1, insert: view.state.toText('\n1\n2') },
      userEvent: 'input.paste',
    });
    expect(view.state.doc.lines).toBe(4);
    expect(tab().content).toBe('a\r\n1\r\n2\r\nb');
  });

  it('LF 文件行为不变', () => {
    const { view } = openAndRender('a\nb\n');
    typeAtEndOfFirstLine(view, 'X');
    expect(tab().content).toBe('aX\nb\n');
    undo(view);
    expect(tab().dirty).toBe(false);
  });

  it('混合换行文件维持既有行为(编辑后统一为 LF)', () => {
    const { view } = openAndRender('a\r\nb\nc');
    typeAtEndOfFirstLine(view, 'X');
    expect(tab().content).toBe('aX\nb\nc');
  });

  it('外部重读把 LF 换成 CRLF(及反向)→ 换行风格跟随新内容', () => {
    const { view, rerender, onChange } = openAndRender('a\nb');
    rerender(
      <CodeEditor tabId={PATH} value={'a\r\nb\r\nc'} fileName="a.ts" onChange={onChange} />,
    );
    expect(view.state.doc.lines).toBe(3);
    typeAtEndOfFirstLine(view, 'X');
    expect(tab().content).toBe('aX\r\nb\r\nc');

    rerender(<CodeEditor tabId={PATH} value={'q\nr'} fileName="a.ts" onChange={onChange} />);
    typeAtEndOfFirstLine(view, 'Y');
    expect(tab().content).toBe('qY\nr');
  });

  it('外部重读仅换行风格不同(行内容相同)→ 不整篇替换文档', () => {
    const { view, rerender, onChange } = openAndRender('a\nb');
    const before = view.state.doc;
    rerender(<CodeEditor tabId={PATH} value={'a\r\nb'} fileName="a.ts" onChange={onChange} />);
    expect(view.state.doc).toBe(before);
    typeAtEndOfFirstLine(view, 'X');
    expect(tab().content).toBe('aX\r\nb');
  });
  it('外部重读成 CRLF 内容时光标 clamp 按文档坐标(CRLF 计 1 位),不越界抛错', () => {
    const { view, rerender, onChange } = openAndRender('a\nb\nc');
    view.dispatch({ selection: { anchor: 5 } });
    expect(() =>
      rerender(<CodeEditor tabId={PATH} value={'a\r\nb'} fileName="a.ts" onChange={onChange} />),
    ).not.toThrow();
    expect(view.state.doc.toString()).toBe('a\nb');
    expect(view.state.selection.main.head).toBe(3);
  });
});
