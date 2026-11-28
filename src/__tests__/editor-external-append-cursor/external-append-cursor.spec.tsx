// @vitest-environment jsdom
// 光标在文件末尾时外部追加 → 光标跟到新末尾(VSCode AlwaysGrowsWhenTypingAtEdges + collapseToEnd);别处的光标照常映射;不滚动。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from 'codemirror';

vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_k: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

const views = new Map<string, unknown>();
vi.mock('@/stores/editor.store', () => ({
  useEditorStore: Object.assign(() => undefined, {
    getState: () => ({
      registerView: (id: string, v: unknown) => views.set(id, v),
      unregisterView: (id: string) => views.delete(id),
    }),
  }),
}));

import { CodeEditor } from '../../panels/Editor/CodeEditor';

afterEach(() => {
  cleanup();
  views.clear();
});

function setup(initial: string) {
  const r = render(<CodeEditor tabId="log" value={initial} fileName="app.log" />);
  const view = views.get('log') as EditorView;
  const reload = (next: string) => r.rerender(<CodeEditor tabId="log" value={next} fileName="app.log" />);
  return { view, reload };
}

describe('外部追加时光标跟随', () => {
  it('光标在末尾 → 外部追加后在新末尾;不发滚动请求', () => {
    const initial = 'l1\nl2\n';
    const { view, reload } = setup(initial);
    view.dispatch({ selection: { anchor: initial.length } });
    const dispatch = vi.spyOn(view, 'dispatch');
    reload(`${initial}l3\nl4\n`);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(view.state.selection.main.empty).toBe(true);
    const tr = dispatch.mock.calls.map((c) => c[0] as { scrollIntoView?: boolean; effects?: unknown });
    expect(tr.some((spec) => spec.scrollIntoView === true)).toBe(false);
  });

  it('光标在中部 → 不动', () => {
    const initial = 'l1\nl2\n';
    const { view, reload } = setup(initial);
    view.dispatch({ selection: { anchor: 2 } });
    reload(`${initial}l3\n`);
    expect(view.state.selection.main.head).toBe(2);
  });

  it('多光标各自判断:末尾的跟随,别处的不动', () => {
    const initial = 'aaa\nbbb\n';
    const { view, reload } = setup(initial);
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(initial.length)], 0),
    });
    reload(`${initial}ccc\n`);
    const heads = view.state.selection.ranges.map((r) => r.head);
    expect(heads).toEqual([1, view.state.doc.length]);
    expect(view.state.selection.mainIndex).toBe(0);
  });

  it('非空选区末端恰是插入点 → 插入的文本并入选区', () => {
    const initial = 'head\ntail';
    const { view, reload } = setup(initial);
    view.dispatch({ selection: { anchor: 5, head: initial.length } });
    reload(`${initial} more`);
    expect(view.state.selection.main.from).toBe(5);
    expect(view.state.selection.main.to).toBe(view.state.doc.length);
  });
});
