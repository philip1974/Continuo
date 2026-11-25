// @vitest-environment jsdom
// BDD:代码编辑器 Tab 缩进 / ⇧Tab 反缩进;Esc 后 Tab 交给浏览器移出焦点(VSCode 同)。见同目录 README 第 1 条。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';

vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_k: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { clearEditorViewStates } from '../../panels/Editor/editor-view-state-cache';

const A = '/w/a.ts';
const TEXT = 'line1\nline2\n';

function mount(): EditorView {
  render(<CodeEditor key={A} tabId={A} value={TEXT} fileName={A} onChange={() => {}} />);
  const view = useEditorStore.getState().viewRefs.get(A) as EditorView;
  expect(view).toBeTruthy();
  return view;
}

/** 在编辑区派发一次按键,返回事件是否被编辑器处理(preventDefault)。 */
function press(view: EditorView, init: KeyboardEventInit & { keyCode: number }): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  // jsdom 的 KeyboardEventInit 不认 keyCode;CodeMirror 按 keyCode 判 Tab / Esc
  Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

const TAB = { key: 'Tab', code: 'Tab', keyCode: 9 };

beforeEach(() => {
  clearEditorViewStates();
  useEditorStore.setState({ tabs: [createTab(A, TEXT)], activeTabId: A, viewRefs: new Map() });
});
afterEach(() => cleanup());

describe('代码编辑器 Tab / ⇧Tab', () => {
  it('Tab 缩进当前行并被编辑器处理(焦点不移出)', () => {
    const view = mount();
    view.dispatch({ selection: { anchor: 0 } });
    expect(press(view, TAB)).toBe(true);
    expect(view.state.doc.line(1).text).not.toBe('line1');
    expect(view.state.doc.line(1).text.trim()).toBe('line1');
  });

  it('⇧Tab 反缩进', () => {
    const view = mount();
    view.dispatch({ selection: { anchor: 0 } });
    press(view, TAB);
    expect(press(view, { ...TAB, shiftKey: true })).toBe(true);
    expect(view.state.doc.line(1).text).toBe('line1');
  });

  it('Esc 后紧接着 Tab:编辑器不处理(浏览器默认移出焦点),文档不变', () => {
    const view = mount();
    view.dispatch({ selection: { anchor: 0 } });
    press(view, { key: 'Escape', code: 'Escape', keyCode: 27 });
    expect(press(view, TAB)).toBe(false);
    expect(view.state.doc.toString()).toBe(TEXT);
  });
});
