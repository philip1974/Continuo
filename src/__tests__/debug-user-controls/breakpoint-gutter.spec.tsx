// @vitest-environment jsdom
// 点编辑器断点 gutter 切换断点(VSCode 单击 glyph margin);无会话时红点来自用户断点。见同目录 README。
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ setUserBreakpoint: vi.fn(async () => ({ ok: true as const, data: undefined })) }));
vi.mock('../../lib/co-api', () => ({ coApi: { debug: { setUserBreakpoint: h.setUserBreakpoint } } }));

import { createTab, useEditorStore } from '../../stores/editor.store';
import { resetDebugStoreForTest, useDebugStore, type DebugSessionShadow } from '../../stores/debug.store';
import { debugDecorationsExtension } from '../../panels/Editor/decorations/debug-decorations';
import { startDebugDecorationSync } from '../../panels/Editor/decorations/debug-decoration-sync';
import { breakpointGutterToggle, toggleBreakpointInView } from '../../panels/Editor/decorations/breakpoint-gutter-toggle';

const views: EditorView[] = [];
let stopSync: (() => void) | null = null;

beforeAll(() => {
  if (!Range.prototype.getClientRects) Object.defineProperty(Range.prototype, 'getClientRects', { value: () => [] });
});

afterEach(() => {
  stopSync?.();
  stopSync = null;
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  resetDebugStoreForTest();
  useEditorStore.setState({ tabs: [], activeTabId: null, viewRefs: new Map() });
  vi.clearAllMocks();
});

function createView(filePath: string): EditorView {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: 'one\ntwo\nthree\nfour\n',
      extensions: [debugDecorationsExtension(), breakpointGutterToggle()],
    }),
    parent,
  });
  views.push(view);
  const tab = createTab(filePath, view.state.doc.toString());
  useEditorStore.setState((state) => ({
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
    viewRefs: new Map(state.viewRefs).set(tab.id, view),
  }));
  return view;
}

const markers = (view: EditorView) => view.dom.querySelectorAll('.cm-debug-breakpoint-marker').length;

function session(breakpoints: DebugSessionShadow['breakpoints']): DebugSessionShadow {
  return { id: 's1', breakpoints, frames: [], scopes: [], variableRefs: new Map(), lastStoppedOrder: 0 };
}

describe('断点 gutter 切换', () => {
  it('单击 gutter 列 → 该行新增用户断点(左键;行号 / 正文不触发)', () => {
    const view = createView('/repo/app.js');
    const gutter = view.dom.querySelector('.cm-breakpoint-gutter')!;
    gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientY: 0 }));
    expect(h.setUserBreakpoint).toHaveBeenCalledWith({ file: '/repo/app.js', line: 1, enabled: true });
    h.setUserBreakpoint.mockClear();
    gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, clientY: 0 }));
    view.contentDOM.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientY: 0 }));
    expect(h.setUserBreakpoint).not.toHaveBeenCalled();
  });

  it('无会话:红点显示用户断点;点已有红点的行 → 删除', () => {
    stopSync = startDebugDecorationSync();
    const view = createView('/repo/app.js');
    useDebugStore.setState({ userBreakpoints: [{ file: '/repo/app.js', line: 2 }] });
    expect(markers(view)).toBe(1);
    toggleBreakpointInView(view, 2);
    expect(h.setUserBreakpoint).toHaveBeenCalledWith({ file: '/repo/app.js', line: 2, enabled: false });
  });

  it('有会话:红点显示会话断点(校正后的行),用户断点不重复显示;点校正后的行 → 删除', () => {
    stopSync = startDebugDecorationSync();
    const view = createView('/repo/app.js');
    useDebugStore.setState({
      userBreakpoints: [{ file: '/repo/app.js', line: 2 }],
      sessions: new Map([['s1', session([{ file: '/repo/app.js', line: 3, verified: true }])]]),
    });
    expect(markers(view)).toBe(1);
    toggleBreakpointInView(view, 3);
    expect(h.setUserBreakpoint).toHaveBeenLastCalledWith({ file: '/repo/app.js', line: 3, enabled: false });
    toggleBreakpointInView(view, 2);
    expect(h.setUserBreakpoint).toHaveBeenLastCalledWith({ file: '/repo/app.js', line: 2, enabled: true });
  });

  it('Markdown 文件不切换', () => {
    const view = createView('/repo/README.md');
    toggleBreakpointInView(view, 1);
    expect(h.setUserBreakpoint).not.toHaveBeenCalled();
  });
});
