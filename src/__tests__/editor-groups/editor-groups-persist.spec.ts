// @vitest-environment jsdom
// BDD:编辑器组的会话持久化(向后兼容:单组写出旧形态;旧格式读成单组;多组按组恢复)。见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTab,
  editorGroupIdsOf,
  groupActiveTabIdOf,
  groupTabsOf,
  useEditorStore,
} from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import {
  hydrateEditorTabs,
  snapshotFromStores,
  type EditorSessionFsApi,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';
import { ExplorerWritableSnapshotSchema } from '../../../electron/shared/explorer-persistence-schema';

const A = '/w/a.ts';
const B = '/w/b.ts';
const C = '/w/c.ts';

function reset(): void {
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    mode: 'source',
    viewRefs: new Map(),
  });
}

beforeEach(reset);

function open(path: string): void {
  useEditorStore.getState().openTab(createTab(path, path));
}

function fsOf(files: readonly string[]): EditorSessionFsApi {
  return {
    readFile: vi.fn(async (p: string) =>
      files.includes(p)
        ? { ok: true as const, data: `content of ${p}` }
        : { ok: false as const, code: 'FS_ENOENT', message: 'not found' },
    ),
  };
}

function snapWith(editor: NonNullable<ExplorerSnapshot['windows'][number]['editor']>): ExplorerSnapshot {
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
  } as ExplorerSnapshot;
}

describe('写出', () => {
  it('单组:与旧版形态一致(无 groups / activeGroup)', () => {
    open(A);
    open(B);
    expect(snapshotFromStores().windows[0]!.editor).toEqual({ openFilePaths: [A, B], activePath: B });
  });

  it('多组:openFilePaths = 全部文档,activePath = 活动组的活动文件,另写 groups 与 activeGroup', () => {
    open(A);
    open(B);
    useEditorStore.getState().splitGroup('editor', 'editor:2', A);
    open(C);
    const editor = snapshotFromStores().windows[0]!.editor!;
    expect(editor.openFilePaths).toEqual([A, B, C]);
    expect(editor.activePath).toBe(C);
    expect(editor.groups).toEqual([
      { id: 'editor', openFilePaths: [A, B], activePath: B },
      { id: 'editor:2', openFilePaths: [A, C], activePath: C },
    ]);
    expect(editor.activeGroup).toBe('editor:2');
  });

  it('写出的快照通过磁盘 schema(main 端 explorer:write 校验)', () => {
    open(A);
    useEditorStore.getState().splitGroup('editor', 'editor:2');
    expect(ExplorerWritableSnapshotSchema.safeParse(snapshotFromStores()).success).toBe(true);
  });

  it('schema 拒绝畸形组 id', () => {
    open(A);
    useEditorStore.getState().splitGroup('editor', 'editor:2');
    const snap = snapshotFromStores();
    const bad = {
      ...snap,
      windows: [{ ...snap.windows[0]!, editor: { ...snap.windows[0]!.editor!, activeGroup: '../x' } }],
    };
    expect(ExplorerWritableSnapshotSchema.safeParse(bad).success).toBe(false);
  });
});

describe('恢复', () => {
  it('旧格式(无 groups)→ 单组', async () => {
    await hydrateEditorTabs(snapWith({ openFilePaths: [A, B], activePath: A }), fsOf([A, B]));
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor']);
    expect(s.tabs.map((t) => t.id)).toEqual([A, B]);
    expect(s.activeTabId).toBe(A);
  });

  it('多组:按组分配,恢复活动组与各组活动文件', async () => {
    await hydrateEditorTabs(
      snapWith({
        openFilePaths: [A, B, C],
        activePath: C,
        groups: [
          { id: 'editor', openFilePaths: [A, B], activePath: A },
          { id: 'editor:2', openFilePaths: [B, C], activePath: C },
        ],
        activeGroup: 'editor:2',
      }),
      fsOf([A, B, C]),
    );
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor', 'editor:2']);
    expect(groupTabsOf(s, 'editor').map((t) => t.id)).toEqual([A, B]);
    expect(groupTabsOf(s, 'editor:2').map((t) => t.id)).toEqual([B, C]);
    expect(groupActiveTabIdOf(s, 'editor')).toBe(A);
    expect(s.activeGroupId).toBe('editor:2');
    expect(s.activeTabId).toBe(C);
  });

  it('读盘失败的文件跳过;因此没有文档的组丢弃', async () => {
    await hydrateEditorTabs(
      snapWith({
        openFilePaths: [A, C],
        activePath: C,
        groups: [
          { id: 'editor', openFilePaths: [A], activePath: A },
          { id: 'editor:2', openFilePaths: [C], activePath: C },
        ],
        activeGroup: 'editor:2',
      }),
      fsOf([A]),
    );
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor']);
    expect(s.tabs.map((t) => t.id)).toEqual([A]);
    expect(s.activeTabId).toBe(A);
  });
});
