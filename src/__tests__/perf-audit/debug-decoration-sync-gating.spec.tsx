// @vitest-environment jsdom
// perf E4:debug 装饰同步只在相关切片变化时才扫描 —— editor 侧 viewRefs / chromeVersion
// (tab 增删/改名/改路径都会 bump),debug 侧 activeSessionId / 各 session 的 breakpoints、stopped 引用。
// 每按键(updateContent 换 tabs、chromeVersion 不变)与 loadVariables 等无关 debug 更新不再做
// O(T²+T·B) 的 tab 查找 + 断点路径比较。正文变化后的装饰重建由 CodeMirror StateField 在
// docChanged 时按行号自行完成(见 debug-decorations),不依赖 store 通知。
// 扫描计数:每次同步对断点/停点做 pathEquals 比较 → 包一层计数。

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ pathEqualsCalls: 0 }));

vi.mock('@/lib/path-cross', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/path-cross')>();
  return {
    ...orig,
    pathEquals: (a: string, b: string) => {
      h.pathEqualsCalls += 1;
      return orig.pathEquals(a, b);
    },
  };
});

import { createTab, useEditorStore } from '../../stores/editor.store';
import {
  resetDebugStoreForTest,
  useDebugStore,
  type DebugSessionShadow,
} from '../../stores/debug.store';
import { debugDecorationsExtension } from '../../panels/Editor/decorations/debug-decorations';
import { startDebugDecorationSync } from '../../panels/Editor/decorations/debug-decoration-sync';

const createdViews: EditorView[] = [];
let stopSync: (() => void) | null = null;

beforeAll(() => {
  if (!Range.prototype.getClientRects) {
    Object.defineProperty(Range.prototype, 'getClientRects', { value: () => [] });
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

function createView(): EditorView {
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
  return view;
}

function session(id: string, patch: Partial<DebugSessionShadow>): DebugSessionShadow {
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

function markers(view: EditorView): number {
  return view.dom.querySelectorAll('.cm-debug-breakpoint-marker').length;
}

function setup(): EditorView {
  const view = createView();
  const editor = useEditorStore.getState();
  editor.openTab(createTab('/repo/a.ts', view.state.doc.toString()));
  editor.registerView('/repo/a.ts', view);
  useDebugStore.setState({
    activeSessionId: 's1',
    sessions: new Map([
      [
        's1',
        session('s1', {
          breakpoints: [{ file: '/repo/a.ts', line: 2, verified: true }],
          stopped: { reason: 'breakpoint', stopSeq: 1, pausedEpoch: 1, file: '/repo/a.ts', line: 3 },
          lastStoppedOrder: 1,
        }),
      ],
    ]),
  });
  stopSync = startDebugDecorationSync();
  expect(markers(view)).toBe(1);
  expect(view.dom.querySelector('.cm-debug-exec-line')).toBeTruthy();
  return view;
}

describe('perf E4 — debug 装饰同步按相关切片门控', () => {
  it('按键(updateContent)不触发扫描;正文变化后装饰仍由 StateField 按行号保持', () => {
    const view = setup();
    h.pathEqualsCalls = 0;

    const editor = useEditorStore.getState();
    editor.updateContent('/repo/a.ts', 'one\ntwo\nthree\nfour\nfive\n'); // 变脏 → chromeVersion bump(允许一次同步)
    h.pathEqualsCalls = 0;
    for (let i = 0; i < 5; i += 1) {
      useEditorStore.getState().updateContent('/repo/a.ts', `typed ${i}`); // 已脏,chrome 不变
    }
    expect(h.pathEqualsCalls).toBe(0);

    view.dispatch({ changes: { from: 0, insert: 'zero\n' } });
    expect(markers(view)).toBe(1);
    expect(view.dom.querySelector('.cm-debug-exec-line')).toBeTruthy();
  });

  it('无关 debug 更新(变量缓存等,breakpoints/stopped 引用不变)不触发扫描', () => {
    setup();
    h.pathEqualsCalls = 0;

    useDebugStore.setState((s) => {
      const cur = s.sessions.get('s1')!;
      return { sessions: new Map(s.sessions).set('s1', { ...cur, variablesCache: new Map() }) };
    });
    expect(h.pathEqualsCalls).toBe(0);
  });

  it('相关变化仍同步:停点移动 / 断点变更 / 关闭 tab / 新开 view', () => {
    const view = setup();

    // stopped 换新对象(帧拉取补 file/line)→ 停点行更新
    useDebugStore.setState((s) => {
      const cur = s.sessions.get('s1')!;
      return {
        sessions: new Map(s.sessions).set('s1', {
          ...cur,
          stopped: { ...cur.stopped!, line: 4 },
        }),
      };
    });
    const execLine = view.dom.querySelector('.cm-debug-exec-line');
    expect(execLine?.textContent).toBe('four');

    // 断点变更 → gutter 更新
    useDebugStore.setState((s) => {
      const cur = s.sessions.get('s1')!;
      return {
        sessions: new Map(s.sessions).set('s1', {
          ...cur,
          breakpoints: [
            { file: '/repo/a.ts', line: 1, verified: true },
            { file: '/repo/a.ts', line: 2, verified: true },
          ],
        }),
      };
    });
    expect(markers(view)).toBe(2);

    // 新开 view(registerView 改 viewRefs)→ 立即贴装饰
    const other = createView();
    useEditorStore.getState().openTab(createTab('/repo/b.ts', other.state.doc.toString()));
    useDebugStore.setState((s) => {
      const cur = s.sessions.get('s1')!;
      return {
        sessions: new Map(s.sessions).set('s1', {
          ...cur,
          breakpoints: [...cur.breakpoints, { file: '/repo/b.ts', line: 3, verified: true }],
        }),
      };
    });
    useEditorStore.getState().registerView('/repo/b.ts', other);
    expect(markers(other)).toBe(1);

    // 改路径(renamePath:.ts → .md)→ markdown tab 清空装饰
    useEditorStore.getState().renamePath('/repo/b.ts', '/repo/b.md');
    expect(markers(other)).toBe(0);

    // 关闭 tab(store action,chromeVersion bump)→ 清掉残留装饰
    useEditorStore.getState().closeTab('/repo/a.ts');
    expect(markers(view)).toBe(0);
    expect(view.dom.querySelector('.cm-debug-exec-line')).toBeNull();
  });
});
