// @vitest-environment jsdom
// topic-51 Phase 3 Op1/Op2:CodeMirror debug decorations stay internal to renderer.

import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

let lineNumbersSetting = true;

vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (key: string, fallback: unknown) =>
    key === 'editor.lineNumbers' ? lineNumbersSetting : fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

const views = new Map<string, unknown>();
vi.mock('@/stores/editor.store', () => ({
  useEditorStore: Object.assign(() => undefined, {
    getState: () => ({
      registerView: (id: string, v: unknown) => views.set(id, v),
      unregisterView: (id: string, expected: unknown) => {
        if (views.get(id) === expected) views.delete(id);
      },
    }),
  }),
}));

import { CodeEditor } from '../../panels/Editor/CodeEditor';
import {
  debugDecorationsExtension,
  setDebugDecorations,
} from '../../panels/Editor/decorations/debug-decorations';

beforeAll(() => {
  if (!Range.prototype.getClientRects) {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      value: () => [],
    });
  }
});

function createView(extensions: Extension[] = []) {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: 'one\ntwo\nthree\n',
      extensions: [basicSetup, ...extensions],
    }),
    parent,
  });
  return { parent, view };
}

afterEach(() => {
  cleanup();
  views.clear();
  lineNumbersSetting = true;
  document.body.replaceChildren();
});

describe('topic51 Phase3 Op1/Op2 · debug decorations', () => {
  it('sets and clears breakpoint gutter markers plus exec-line decoration', () => {
    const { view } = createView([debugDecorationsExtension()]);

    setDebugDecorations(view, { breakpointLines: [2], execLine: 3 });

    expect(view.dom.querySelector('.cm-breakpoint-gutter')).toBeTruthy();
    expect(view.dom.querySelector('.cm-debug-breakpoint-marker')).toBeTruthy();
    expect(view.dom.querySelector('.cm-debug-exec-line')).toBeTruthy();

    setDebugDecorations(view, { breakpointLines: [], execLine: null });

    expect(view.dom.querySelector('.cm-debug-breakpoint-marker')).toBeNull();
    expect(view.dom.querySelector('.cm-debug-exec-line')).toBeNull();
  });

  it('keeps breakpoint gutter separate from CodeMirror line numbers', () => {
    const { view } = createView([lineNumbers(), debugDecorationsExtension()]);

    setDebugDecorations(view, { breakpointLines: [1], execLine: null });

    expect(view.dom.querySelector('.cm-lineNumbers')).toBeTruthy();
    expect(view.dom.querySelector('.cm-breakpoint-gutter')).toBeTruthy();
    expect(view.dom.querySelector('.cm-debug-breakpoint-marker')).toBeTruthy();
  });

  it('CodeEditor hides line-number/fold gutters but keeps breakpoint gutter when line numbers are off', () => {
    lineNumbersSetting = false;
    render(<CodeEditor tabId="t1" value="one\ntwo\nthree\n" fileName="a.ts" />);
    const view = views.get('t1') as EditorView;

    setDebugDecorations(view, { breakpointLines: [1], execLine: null });

    const lineNumberGutter = view.dom.querySelector('.cm-lineNumbers') as HTMLElement;
    const foldGutter = view.dom.querySelector('.cm-foldGutter') as HTMLElement;
    const breakpointGutter = view.dom.querySelector('.cm-breakpoint-gutter') as HTMLElement;

    expect(view.dom.classList.contains('cm-no-gutters')).toBe(true);
    expect(lineNumberGutter).toBeTruthy();
    expect(foldGutter).toBeTruthy();
    expect(breakpointGutter).toBeTruthy();
    expect(getComputedStyle(lineNumberGutter).display).toBe('none');
    expect(getComputedStyle(foldGutter).display).toBe('none');
    expect(getComputedStyle(breakpointGutter).display).not.toBe('none');
    expect(view.dom.querySelector('.cm-debug-breakpoint-marker')).toBeTruthy();
  });
});
