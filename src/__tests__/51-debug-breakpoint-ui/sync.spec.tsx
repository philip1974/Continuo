// @vitest-environment jsdom

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { resetDebugStoreForTest, useDebugStore } from '../../stores/debug.store';
import { debugDecorationsExtension } from '../../panels/Editor/decorations/debug-decorations';
import { startDebugDecorationSync } from '../../panels/Editor/decorations/debug-decoration-sync';
import type { DebugSessionShadow } from '../../stores/debug.store';

const createdViews: EditorView[] = [];
let stopSync: (() => void) | null = null;

beforeAll(() => {
  if (!Range.prototype.getClientRects) {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      value: () => [],
    });
  }
});

afterEach(() => {
  stopSync?.();
  stopSync = null;
  for (const view of createdViews.splice(0)) view.destroy();
  document.body.replaceChildren();
  resetDebugStoreForTest();
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    mode: 'source',
    viewRefs: new Map(),
  });
});

function createView(tabId: string, filePath: string): EditorView {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: 'one\ntwo\nthree\nfour\n',
      extensions: [debugDecorationsExtension()],
    }),
    parent,
  });
  createdViews.push(view);
  useEditorStore.setState((state) => ({
    tabs: [...state.tabs, createTab(filePath, view.state.doc.toString())],
    activeTabId: tabId,
    viewRefs: new Map(state.viewRefs).set(tabId, view),
  }));
  return view;
}

function session(
  id: string,
  patch: Partial<DebugSessionShadow>,
): DebugSessionShadow {
  return {
    id,
    breakpoints: [],
    frames: [],
    scopes: [],
    variableRefs: new Map(),
    variablesCache: new Map(),
    lastStoppedOrder: 0,
    ...patch,
  };
}

describe('topic51 Op6 · debug decoration sync', () => {
  it('syncs matching breakpoints to the gutter and active stopped location to exec-line', () => {
    const view = createView('/repo/a.ts', '/repo/a.ts');
    useDebugStore.setState({
      activeSessionId: 's1',
      sessions: new Map([
        [
          's1',
          session('s1', {
            breakpoints: [
              { file: '/repo/a.ts', line: 2, verified: true },
              { file: '/repo/b.ts', line: 3, verified: true },
            ],
            stopped: {
              reason: 'breakpoint',
              stopSeq: 1,
              pausedEpoch: 1,
              file: '/repo/a.ts',
              line: 3,
            },
            lastStoppedOrder: 1,
          }),
        ],
      ]),
    });

    stopSync = startDebugDecorationSync();

    expect(view.dom.querySelectorAll('.cm-debug-breakpoint-marker')).toHaveLength(1);
    expect(view.dom.querySelector('.cm-debug-exec-line')).toBeTruthy();
  });

  it('clears exec-line after continued and terminated events remove stopped state', () => {
    const view = createView('/repo/a.ts', '/repo/a.ts');
    useDebugStore.setState({
      activeSessionId: 's1',
      sessions: new Map([
        [
          's1',
          session('s1', {
            stopped: {
              reason: 'breakpoint',
              stopSeq: 1,
              pausedEpoch: 1,
              file: '/repo/a.ts',
              line: 2,
            },
            lastStoppedOrder: 1,
          }),
        ],
      ]),
    });
    stopSync = startDebugDecorationSync();
    expect(view.dom.querySelector('.cm-debug-exec-line')).toBeTruthy();

    useDebugStore.setState({
      activeSessionId: null,
      sessions: new Map([
        [
          's1',
          session('s1', {
            stopped: undefined,
            lastStoppedOrder: 1,
          }),
        ],
      ]),
    });
    expect(view.dom.querySelector('.cm-debug-exec-line')).toBeNull();

    useDebugStore.setState({ sessions: new Map(), activeSessionId: null });
    expect(view.dom.querySelector('.cm-debug-exec-line')).toBeNull();
  });

  it('skips markdown tabs and clears stale decorations for closed tabs', () => {
    const markdownView = createView('/repo/readme.md', '/repo/readme.md');
    const codeView = createView('/repo/a.ts', '/repo/a.ts');
    useDebugStore.setState({
      activeSessionId: 's1',
      sessions: new Map([
        [
          's1',
          session('s1', {
            breakpoints: [
              { file: '/repo/readme.md', line: 2, verified: true },
              { file: '/repo/a.ts', line: 2, verified: true },
            ],
            stopped: {
              reason: 'breakpoint',
              stopSeq: 1,
              pausedEpoch: 1,
              file: '/repo/readme.md',
              line: 3,
            },
            lastStoppedOrder: 1,
          }),
        ],
      ]),
    });

    stopSync = startDebugDecorationSync();

    expect(markdownView.dom.querySelector('.cm-debug-breakpoint-marker')).toBeNull();
    expect(markdownView.dom.querySelector('.cm-debug-exec-line')).toBeNull();
    expect(codeView.dom.querySelector('.cm-debug-breakpoint-marker')).toBeTruthy();

    useEditorStore.setState((state) => ({
      tabs: state.tabs.filter((tab) => tab.id !== '/repo/a.ts'),
    }));

    expect(codeView.dom.querySelector('.cm-debug-breakpoint-marker')).toBeNull();
    expect(codeView.dom.querySelector('.cm-debug-exec-line')).toBeNull();
  });

  it('uses path-cross pathEquals semantics for Windows case-insensitive matching', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true,
    });
    try {
      const view = createView('C:\\Repo\\a.ts', 'C:\\Repo\\a.ts');
      useDebugStore.setState({
        activeSessionId: 's1',
        sessions: new Map([
          [
            's1',
            session('s1', {
              breakpoints: [{ file: 'c:\\repo\\a.ts', line: 2, verified: true }],
              stopped: {
                reason: 'breakpoint',
                stopSeq: 1,
                pausedEpoch: 1,
                file: 'c:\\repo\\a.ts',
                line: 3,
              },
              lastStoppedOrder: 1,
            }),
          ],
        ]),
      });

      stopSync = startDebugDecorationSync();

      expect(view.dom.querySelector('.cm-debug-breakpoint-marker')).toBeTruthy();
      expect(view.dom.querySelector('.cm-debug-exec-line')).toBeTruthy();
    } finally {
      if (original) Object.defineProperty(navigator, 'platform', original);
      else delete (navigator as { platform?: string }).platform;
    }
  });
});

