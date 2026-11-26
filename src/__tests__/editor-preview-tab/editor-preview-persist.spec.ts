// @vitest-environment jsdom
// BDD:预览 tab 随会话快照保存 / 恢复(窗口段与按文件夹快照同一 schema);旧数据按常驻。见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTab, groupPreviewTabIdOf, useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import {
  hydrateEditorTabs,
  snapshotFromStores,
  type EditorSessionFsApi,
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
    tabMru: new Map(),
    previewTabs: new Map(),
    mode: 'source',
    viewRefs: new Map(),
  });
}

beforeEach(reset);

const st = () => useEditorStore.getState();
const fs: EditorSessionFsApi = {
  readFile: vi.fn(async (p: string) => ({ ok: true as const, data: `content of ${p}` })),
};

describe('单组', () => {
  it('快照写 editor.previewPath(通过 schema 校验),恢复后它仍是预览 tab', async () => {
    st().openTab(createTab(A, 'a'));
    st().openTab(createTab(B, 'b'), { preview: true });
    const snap = snapshotFromStores();
    expect(snap.windows[0]!.editor!.previewPath).toBe(B);
    expect(ExplorerWritableSnapshotSchema.safeParse(snap).success).toBe(true);
    reset();
    await hydrateEditorTabs(snap, fs);
    expect(st().tabs.map((t) => t.id)).toEqual([A, B]);
    expect(groupPreviewTabIdOf(st(), 'editor')).toBe(B);
  });

  it('没有预览 tab → 不写该字段(旧形态不变)', () => {
    st().openTab(createTab(A, 'a'));
    expect(snapshotFromStores().windows[0]!.editor).not.toHaveProperty('previewPath');
  });

  it('旧数据(无 previewPath)→ 全部常驻', async () => {
    st().openTab(createTab(A, 'a'));
    st().openTab(createTab(B, 'b'));
    const snap = snapshotFromStores();
    reset();
    await hydrateEditorTabs(snap, fs);
    expect(st().tabs).toHaveLength(2);
    expect(st().previewTabs.size).toBe(0);
  });

  it('插件打开的预览 tab 不记(同 openFilePaths)', () => {
    st().openTab({ ...createTab(A, 'a'), pluginOpenedPath: A }, { preview: true });
    expect(snapshotFromStores().windows[0]!.editor).not.toHaveProperty('previewPath');
  });
});

describe('多组', () => {
  it('各组写 previewPath,恢复后按组还原', async () => {
    st().openTab(createTab(A, 'a'));
    expect(st().splitGroup('editor', 'editor:2', A)).toBe(true);
    st().openTab(createTab(B, 'b'), { preview: true, groupId: 'editor' });
    st().openTab(createTab(C, 'c'), { preview: true, groupId: 'editor:2' });
    const snap = snapshotFromStores();
    const groups = snap.windows[0]!.editor!.groups!;
    expect(groups.map((g) => g.previewPath)).toEqual([B, C]);
    expect(ExplorerWritableSnapshotSchema.safeParse(snap).success).toBe(true);
    reset();
    await hydrateEditorTabs(snap, fs);
    expect(groupPreviewTabIdOf(st(), 'editor')).toBe(B);
    expect(groupPreviewTabIdOf(st(), 'editor:2')).toBe(C);
  });
});
