// @vitest-environment jsdom
// 编辑器视图状态按「编辑器组 + 文件」保存(VSCode EditorMemento),含折叠区域。见同目录 README.md。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { foldedRanges, foldEffect } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';

vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_k: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { EditorGroupIdContext } from '../../panels/Editor/editor-group-context';
import { createTab, liveEditorViewOf, useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { clearEditorViewStates, hasCodeEditorViewState } from '../../panels/Editor/editor-view-state-cache';
import {
  hydrateEditorTabs,
  snapshotFromStores,
  type EditorSessionFsApi,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';
import {
  EDITOR_VIEW_FOLDS_MAX,
  ExplorerSchemaV3,
  ExplorerWritableSnapshotSchema,
} from '../../../electron/shared/explorer-persistence-schema';

const A = '/w/long.ts';
const G1 = 'editor';
const G2 = 'editor:2';
const LONG = Array.from({ length: 300 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n';
const BAD = '/w/bad.js';
const BAD_JS = 'function alpha() {\n  const a = 1;\n  return a;\n}\n\nfunction beta() {\n  return 2;\n}\n';

type EditorSession = NonNullable<ExplorerSnapshot['windows'][number]['editor']>;

function snapWith(editor: EditorSession): ExplorerSnapshot {
  return {
    version: 3,
    workspace: { recentRoots: [] },
    pinned: { paths: [] },
    nextWindowSeq: 1,
    windows: [
      {
        windowSeq: 0,
        workspace: { root: null },
        explorer: { activePath: null, expandedPaths: [], sort: { by: 'name', reverse: false } },
        editor,
      },
    ],
  };
}

function fsOf(files: Record<string, string>): EditorSessionFsApi {
  return {
    readFile: vi.fn(async (p: string) =>
      files[p] === undefined
        ? { ok: false as const, code: 'FS_ENOENT', message: 'nf' }
        : { ok: true as const, data: files[p]! },
    ),
  };
}

/** 在组 groupId 里挂载 tabId 的 CodeEditor。 */
function mountIn(groupId: string, tabId: string, value: string) {
  const r = render(
    <EditorGroupIdContext.Provider value={groupId}>
      <CodeEditor key={tabId} tabId={tabId} value={value} fileName={tabId} onChange={() => {}} />
    </EditorGroupIdContext.Provider>,
  );
  const view = useEditorStore.getState().viewRefs.get(tabId) as EditorView; // 刚挂载的即最近登记的
  expect(view).toBeTruthy();
  expect(liveEditorViewOf(tabId, groupId)).toBe(view);
  return { ...r, view };
}

/** 同一文件在两个组(左 G1、右 G2)。 */
function twoGroupsWith(tabId: string, value: string): void {
  useEditorStore.setState({
    tabs: [createTab(tabId, value)],
    activeTabId: tabId,
    groups: [
      { id: G1, tabIds: [tabId], activeTabId: tabId },
      { id: G2, tabIds: [tabId], activeTabId: tabId },
    ],
    activeGroupId: G2,
  });
}

const lineFrom = (view: EditorView, n: number): number => view.state.doc.line(n).from;
const cursorLine = (view: EditorView): number => view.state.doc.lineAt(view.state.selection.main.head).number;
const viewStatesOf = (snap: ExplorerSnapshot) => snap.windows[0]!.editor!.viewStates;

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  clearEditorViewStates();
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: G1, tabIds: [], activeTabId: null }],
    activeGroupId: G1,
    mode: 'source',
    viewRefs: new Map(),
  });
});
afterEach(() => cleanup());

describe('同一文件在两个编辑器组:视图状态按组分别保存', () => {
  it('写快照:每个组各一条,各取该组自己的视图(不是最后登记的那个)', () => {
    twoGroupsWith(A, LONG);
    const left = mountIn(G1, A, LONG);
    const right = mountIn(G2, A, LONG);
    left.view.dispatch({ selection: { anchor: lineFrom(left.view, 300) } });
    right.view.dispatch({ selection: { anchor: lineFrom(right.view, 10) } });

    const states = viewStatesOf(snapshotFromStores())!;
    expect(states.map((v) => [v.group, v.path, v.selection?.head])).toEqual([
      [G1, A, lineFrom(left.view, 300)],
      [G2, A, lineFrom(right.view, 10)],
    ]);
    expect(ExplorerWritableSnapshotSchema.safeParse(snapshotFromStores()).success).toBe(true);
  });

  it('只有一个组:条目不带 group(旧形态不变)', () => {
    useEditorStore.setState({ tabs: [createTab(A, LONG)], activeTabId: A });
    const { view } = mountIn(G1, A, LONG);
    view.dispatch({ selection: { anchor: 5 } });
    expect(viewStatesOf(snapshotFromStores())).toEqual([{ path: A, selection: { anchor: 5, head: 5 }, topLine: 1 }]);
  });

  it('恢复:每个组按自己的条目恢复光标;不做操作再写快照与上次一致(连续重启不退化)', async () => {
    const left = LONG.indexOf('const line300 ');
    const right = LONG.indexOf('const line10 ');
    const saved = snapWith({
      openFilePaths: [A],
      activePath: A,
      groups: [
        { id: G1, openFilePaths: [A], activePath: A },
        { id: G2, openFilePaths: [A], activePath: A },
      ],
      activeGroup: G2,
      viewStates: [
        { path: A, group: G1, selection: { anchor: left, head: left }, topLine: 290 },
        { path: A, group: G2, selection: { anchor: right, head: right }, topLine: 1 },
      ],
    });
    await hydrateEditorTabs(saved, fsOf({ [A]: LONG }));
    expect(useEditorStore.getState().groups.map((g) => g.id)).toEqual([G1, G2]);
    // 挂载顺序与登记顺序无关:右组先挂
    const r = mountIn(G2, A, LONG);
    const l = mountIn(G1, A, LONG);
    expect(l.view.state.selection.main.head).toBe(left);
    expect(r.view.state.selection.main.head).toBe(right);
    expect(viewStatesOf(snapshotFromStores())).toEqual(saved.windows[0]!.editor!.viewStates);
  });

  it('旧数据(条目无 group)+ 多个组:各组都用这一条', async () => {
    await hydrateEditorTabs(
      snapWith({
        openFilePaths: [A],
        activePath: A,
        groups: [
          { id: G1, openFilePaths: [A], activePath: A },
          { id: G2, openFilePaths: [A], activePath: A },
        ],
        activeGroup: G1,
        viewStates: [{ path: A, selection: { anchor: 40, head: 40 }, topLine: 1 }],
      }),
      fsOf({ [A]: LONG }),
    );
    const l = mountIn(G1, A, LONG);
    const r = mountIn(G2, A, LONG);
    expect(l.view.state.selection.main.head).toBe(40);
    expect(r.view.state.selection.main.head).toBe(40);
  });

  it('会话内:一个组切走再切回取回本组的状态,不被另一组覆盖', () => {
    twoGroupsWith(A, LONG);
    const l1 = mountIn(G1, A, LONG);
    l1.view.dispatch({ selection: { anchor: lineFrom(l1.view, 200) } });
    l1.unmount();
    const r1 = mountIn(G2, A, LONG);
    r1.view.dispatch({ selection: { anchor: lineFrom(r1.view, 20) } });
    r1.unmount();
    expect(cursorLine(mountIn(G1, A, LONG).view)).toBe(200);
    expect(cursorLine(mountIn(G2, A, LONG).view)).toBe(20);
  });

  it('关闭一个组 → 该组的视图状态丢弃', () => {
    twoGroupsWith(A, LONG);
    const r = mountIn(G2, A, LONG);
    r.view.dispatch({ selection: { anchor: 7 } });
    r.unmount();
    expect(hasCodeEditorViewState(A, G2)).toBe(true);
    useEditorStore.getState().removeGroup(G2, 'dirty');
    expect(useEditorStore.getState().groups.map((g) => g.id)).toEqual([G1]);
    expect(hasCodeEditorViewState(A, G2)).toBe(false);
  });
});

describe('视口跟随:未布局的视图按要恢复的位置写快照', () => {
  it('带初始滚动创建、尚未布局(scrollDOM 高 0)→ 快照记初始滚动的首行,不记成文件顶部', async () => {
    await hydrateEditorTabs(
      snapWith({
        openFilePaths: [A],
        activePath: A,
        viewStates: [{ path: A, selection: { anchor: 4000, head: 4000 }, topLine: 190 }],
      }),
      fsOf({ [A]: LONG }),
    );
    const { view } = mountIn(G1, A, LONG);
    expect(view.scrollDOM.clientHeight).toBe(0); // jsdom 无布局 = 隐藏的面板
    expect(viewStatesOf(snapshotFromStores())![0]!.topLine).toBe(190);
  });

  it('已布局时滚动过、随后被隐藏 → 记隐藏前的位置', () => {
    useEditorStore.setState({ tabs: [createTab(A, LONG)], activeTabId: A });
    const { view } = mountIn(G1, A, LONG);
    const height = vi.spyOn(view.scrollDOM, 'clientHeight', 'get').mockReturnValue(400);
    view.scrollDOM.scrollTop = view.documentPadding.top + view.defaultLineHeight * 120;
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    const visibleTop = viewStatesOf(snapshotFromStores())![0]!.topLine!;
    expect(visibleTop).toBeGreaterThan(100);
    height.mockReturnValue(0);
    view.scrollDOM.scrollTop = 0; // display:none 时读作 0
    expect(viewStatesOf(snapshotFromStores())![0]!.topLine).toBe(visibleTop);
  });

  it('顶部可见行扣掉内容区上内边距(部分可见的那一行即首行)', () => {
    useEditorStore.setState({ tabs: [createTab(A, LONG)], activeTabId: A });
    const { view } = mountIn(G1, A, LONG);
    vi.spyOn(view.scrollDOM, 'clientHeight', 'get').mockReturnValue(400);
    const lh = view.defaultLineHeight;
    // 第 10 行底边在 padding + 10 * lh;滚到只剩它最下面 4px 可见:首行仍是第 10 行
    view.scrollDOM.scrollTop = view.documentPadding.top + 10 * lh - 4;
    expect(viewStatesOf(snapshotFromStores())![0]!.topLine).toBe(10);
  });
});

describe('折叠区域跨重启', () => {
  function foldsOf(view: EditorView): Array<{ from: number; to: number }> {
    const out: Array<{ from: number; to: number }> = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      out.push({ from, to });
    });
    return out;
  }

  it('写快照带上折叠区域;恢复时折叠回去', async () => {
    useEditorStore.setState({ tabs: [createTab(BAD, BAD_JS)], activeTabId: BAD });
    const first = mountIn(G1, BAD, BAD_JS);
    const range = { from: BAD_JS.indexOf('{') + 1, to: BAD_JS.indexOf('}') };
    first.view.dispatch({ effects: foldEffect.of(range) });
    const snap = snapshotFromStores();
    expect(viewStatesOf(snap)![0]!.folds).toEqual([range]);
    expect(ExplorerWritableSnapshotSchema.safeParse(snap).success).toBe(true);

    cleanup();
    clearEditorViewStates();
    useEditorStore.setState({ tabs: [], activeTabId: null });
    await hydrateEditorTabs(snap, fsOf({ [BAD]: BAD_JS }));
    expect(foldsOf(mountIn(G1, BAD, BAD_JS).view)).toEqual([range]);
  });

  it('区间越界 / 该处已不可折叠(文件在外部改过)→ 丢弃该项,不抛', async () => {
    const changed = '// header\n' + BAD_JS;
    const stale = { from: BAD_JS.indexOf('{') + 1, to: BAD_JS.indexOf('}') }; // 偏移已错位
    const valid = { from: changed.indexOf('{') + 1, to: changed.indexOf('}') };
    await hydrateEditorTabs(
      snapWith({
        openFilePaths: [BAD],
        activePath: BAD,
        viewStates: [
          { path: BAD, selection: { anchor: 0, head: 0 }, topLine: 1, folds: [stale, { from: 5, to: 99_999 }, valid] },
        ],
      }),
      fsOf({ [BAD]: changed }),
    );
    expect(foldsOf(mountIn(G1, BAD, changed).view)).toEqual([valid]);
  });

  it('schema:folds 超上限 / 畸形、group 不是组 id → 读写都拒', () => {
    const both = [ExplorerWritableSnapshotSchema, ExplorerSchemaV3] as const;
    const fold = { from: 1, to: 2 };
    const ok = snapWith({ openFilePaths: [], activePath: null, viewStates: [{ path: A, group: G2, folds: [fold] }] });
    for (const s of both) expect(s.safeParse(ok).success).toBe(true);
    for (const bad of [
      { path: A, folds: Array.from({ length: EDITOR_VIEW_FOLDS_MAX + 1 }, () => fold) },
      { path: A, folds: [{ from: -1, to: 2 }] },
      { path: A, folds: [{ from: 1, to: 2, x: 1 }] },
      { path: A, group: 'terminal' },
    ]) {
      const snap = snapWith({ openFilePaths: [], activePath: null, viewStates: [bad as never] });
      for (const s of both) expect(s.safeParse(snap).success).toBe(false);
    }
  });
});
