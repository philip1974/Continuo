// @vitest-environment jsdom
// BDD:固定 tab 与组 MRU 随会话持久化(重启保留;旧数据无该字段 = 无)。见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTab, groupStickyTabsOf, groupTabsOf, useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import {
  hydrateEditorTabs,
  snapshotFromStores,
  type EditorSessionFsApi,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';
import { ExplorerWritableSnapshotSchema } from '../../../electron/shared/explorer-persistence-schema';
import { scopeWorkspaceSnapshot } from '../../../electron/main/services/workspace-snapshot.service';

const A = '/w/a.ts';
const B = '/w/b.ts';
const C = '/w/c.ts';
const st = () => useEditorStore.getState();

function reset(): void {
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    groupMru: ['editor'],
    tabMru: new Map(),
    previewTabs: new Map(),
    stickyTabs: new Map(),
    mode: 'source',
    viewRefs: new Map(),
  });
}

beforeEach(reset);

function open(path: string): void {
  st().openTab(createTab(path, path));
}

const fs: EditorSessionFsApi = {
  readFile: vi.fn(async (p: string) => ({ ok: true as const, data: `content of ${p}` })),
};

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

describe('固定 tab', () => {
  it('单组:写出 stickyPaths;没有固定的 tab 不写(旧形态不变)', () => {
    open(A);
    open(B);
    expect(snapshotFromStores().windows[0]!.editor).not.toHaveProperty('stickyPaths');
    st().pinEditor(B);
    const editor = snapshotFromStores().windows[0]!.editor!;
    expect(editor).toMatchObject({ openFilePaths: [B, A], stickyPaths: [B] });
    expect(ExplorerWritableSnapshotSchema.safeParse(snapshotFromStores()).success).toBe(true);
  });

  it('单组:重启恢复后仍固定、仍在最左', async () => {
    await hydrateEditorTabs(snapWith({ openFilePaths: [A, B, C], activePath: A, stickyPaths: [C] }), fs);
    expect(groupTabsOf(st(), 'editor').map((t) => t.id)).toEqual([C, A, B]);
    expect(groupStickyTabsOf(st(), 'editor')).toEqual([C]);
    expect(st().activeTabId).toBe(A);
  });

  it('多组:各组各自写出 / 恢复 stickyPaths', async () => {
    open(A);
    open(B);
    st().splitGroup('editor', 'editor:2', A);
    open(C);
    st().pinEditor(C, 'editor:2');
    const editor = snapshotFromStores().windows[0]!.editor!;
    expect(editor.groups?.find((g) => g.id === 'editor:2')).toMatchObject({ stickyPaths: [C] });
    expect(ExplorerWritableSnapshotSchema.safeParse(snapshotFromStores()).success).toBe(true);
    reset();
    await hydrateEditorTabs(snapWith(editor), fs);
    expect(groupStickyTabsOf(st(), 'editor:2')).toEqual([C]);
    expect(groupTabsOf(st(), 'editor:2').map((t) => t.id)).toEqual([C, A]);
  });

  it('工作区快照按 root 剔除:root 外的固定路径不写', () => {
    const scoped = scopeWorkspaceSnapshot({
      workspace: { root: '/w' },
      explorer: { activePath: null, expandedPaths: [], sort: { by: 'name', reverse: false } },
      editor: { openFilePaths: [A, '/x/o.ts'], activePath: A, stickyPaths: ['/x/o.ts', A] },
    });
    expect(scoped.editor?.stickyPaths).toEqual([A]);
    const multi = scopeWorkspaceSnapshot({
      workspace: { root: '/w' },
      explorer: { activePath: null, expandedPaths: [], sort: { by: 'name', reverse: false } },
      editor: {
        openFilePaths: [A, B, '/x/o.ts'],
        activePath: A,
        groups: [
          { id: 'editor', openFilePaths: [A, '/x/o.ts'], activePath: A, stickyPaths: ['/x/o.ts', A] },
          { id: 'editor:2', openFilePaths: [B], activePath: B },
          { id: 'editor:3', openFilePaths: ['/x/o.ts'], activePath: '/x/o.ts' },
        ],
        activeGroup: 'editor',
        groupMru: ['editor:3', 'editor', 'editor:2'],
      },
    });
    expect(multi.editor?.groups?.[0]?.stickyPaths).toEqual([A]);
    // 变空的组丢弃,组 MRU 里随之去掉
    expect(multi.editor?.groupMru).toEqual(['editor', 'editor:2']);
  });
});

describe('组 MRU', () => {
  /** 三组 editor(A)/ editor:2(B)/ editor:3(C),最近使用:editor:2 → editor:3 → editor。 */
  function threeGroups(): void {
    open(A);
    st().splitGroup('editor', 'editor:2', null);
    open(B);
    st().splitGroup('editor:2', 'editor:3', null);
    open(C);
    st().setActiveGroup('editor:2');
  }

  it('与默认顺序(活动组 + 其余按组顺序)不同才写 groupMru;重启恢复', async () => {
    threeGroups();
    const editor = snapshotFromStores().windows[0]!.editor!;
    expect(editor.groupMru).toEqual(['editor:2', 'editor:3', 'editor']);
    expect(ExplorerWritableSnapshotSchema.safeParse(snapshotFromStores()).success).toBe(true);
    reset();
    await hydrateEditorTabs(snapWith(editor), fs);
    expect(st().groupMru).toEqual(['editor:2', 'editor:3', 'editor']);
    // 恢复后关闭活动组 → 落到 MRU 的下一个(editor:3),不是左邻(editor)
    st().closeTab(B, 'editor:2');
    expect(st().activeGroupId).toBe('editor:3');
  });

  it('默认顺序不写', () => {
    open(A);
    st().splitGroup('editor', 'editor:2', A);
    expect(snapshotFromStores().windows[0]!.editor).not.toHaveProperty('groupMru');
  });
});
