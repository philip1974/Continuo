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
import { setLocale } from '../../i18n';

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
      extensions: [debugDecorationsExtension(), breakpointGutterToggle(() => filePath)],
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

  it('只有 JS / TS 文件(js mjs cjs jsx ts mts cts tsx)gutter 显示手形指针、点击切换;Markdown / JSON / CSS 等不显示、不切换', () => {
    for (const file of ['/repo/a.js', '/repo/a.MJS', '/repo/a.cjs', '/repo/a.jsx', '/repo/a.ts', '/repo/a.mts', '/repo/a.cts', '/repo/a.tsx']) {
      const view = createView(file);
      expect(view.dom.classList.contains('cm-breakpoints-allowed')).toBe(true);
      toggleBreakpointInView(view, 1);
      expect(h.setUserBreakpoint).toHaveBeenLastCalledWith({ file, line: 1, enabled: true });
    }
    h.setUserBreakpoint.mockClear();
    for (const file of ['/repo/README.md', '/repo/package.json', '/repo/style.css', '/repo/index.html', '/repo/main.py', '/repo/.js']) {
      const view = createView(file);
      expect(view.dom.classList.contains('cm-breakpoints-allowed')).toBe(false);
      toggleBreakpointInView(view, 1);
      view.dom
        .querySelector('.cm-breakpoint-gutter')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientY: 0 }));
    }
    expect(h.setUserBreakpoint).not.toHaveBeenCalled();
  });

  it('停在有断点的行:组合标记(箭头里嵌红点,红点不被盖住),读屏标签说明两者;其它行各自单独标记', () => {
    setLocale('en');
    stopSync = startDebugDecorationSync();
    const view = createView('/repo/app.js');
    useDebugStore.setState({
      sessions: new Map([
        [
          's1',
          {
            ...session([
              { file: '/repo/app.js', line: 2, verified: true },
              { file: '/repo/app.js', line: 4, verified: true },
            ]),
            stopped: { reason: 'breakpoint', stopSeq: 1, file: '/repo/app.js', line: 2 },
            lastStoppedOrder: 1,
          },
        ],
      ]),
      activeSessionId: 's1',
    });
    const combined = view.dom.querySelectorAll('.cm-debug-exec-on-breakpoint');
    expect(combined).toHaveLength(1);
    expect(combined[0]!.getAttribute('aria-label')).toBe('Breakpoint, current execution line');
    // 第 2 行只有组合标记(没有单独的红点被箭头叠住),第 4 行是单独的红点
    expect(markers(view)).toBe(1);
    expect(view.dom.querySelector('.cm-debug-breakpoint-marker')!.getAttribute('aria-label')).toBe('Breakpoint');
    expect(view.dom.querySelectorAll('.cm-debug-exec-marker')).toHaveLength(1);
  });
});
