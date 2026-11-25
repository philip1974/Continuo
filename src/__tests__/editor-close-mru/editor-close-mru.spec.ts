// @vitest-environment jsdom
// BDD:关闭活动编辑器 tab 回到组内最近使用的 tab(VSCode focusRecentEditorAfterClose)。见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTab,
  groupActiveTabIdOf,
  useEditorStore,
} from '../../stores/editor.store';
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
const D = '/w/d.ts';

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

const st = () => useEditorStore.getState();
const open = (path: string, opts?: Parameters<ReturnType<typeof st>['openTab']>[1]) =>
  st().openTab(createTab(path, path), opts);

function fsOf(files: readonly string[]): EditorSessionFsApi {
  return {
    readFile: vi.fn(async (p: string) =>
      files.includes(p)
        ? { ok: true as const, data: `content of ${p}` }
        : { ok: false as const, code: 'FS_ENOENT', message: 'not found' },
    ),
  };
}

describe('单组', () => {
  it('关闭活动 tab → 回到最近使用的 tab,而不是右侧相邻的', () => {
    open(A);
    open(B);
    open(C);
    st().switchTab(A);
    st().switchTab(C);
    st().closeTab(C);
    expect(st().activeTabId).toBe(A);
    // 再关 A → MRU 下一个是 B
    st().closeTab(A);
    expect(st().activeTabId).toBe(B);
  });

  it('关中间的活动 tab:MRU 指向左侧时不落到右侧', () => {
    open(A);
    open(B);
    open(C);
    st().switchTab(A);
    st().switchTab(B);
    st().closeTab(B);
    expect(st().activeTabId).toBe(A);
  });

  it('关闭非活动 tab → 活动 tab 不变,且被关的 tab 不再参与 MRU', () => {
    open(A);
    open(B);
    open(C);
    st().switchTab(B);
    st().switchTab(C);
    st().closeTab(B);
    expect(st().activeTabId).toBe(C);
    st().closeTab(C);
    expect(st().activeTabId).toBe(A);
  });

  it('从未激活过的后台 tab 不在 MRU 里:关闭活动 tab 先回到激活过的', () => {
    open(A);
    open(B);
    open(C, { activate: false });
    st().closeTab(B);
    expect(st().activeTabId).toBe(A);
  });
});

describe('多组', () => {
  it('各组 MRU 独立:在别的组激活同一文档不影响本组', () => {
    open(A);
    open(B);
    open(C);
    st().switchTab(A);
    st().switchTab(C); // editor 组 MRU:C, A, B
    st().splitGroup('editor', 'editor:2', C);
    st().switchTab(B, { groupId: 'editor:2' }); // editor:2 里打开 B(不改 editor 组的 MRU)
    st().closeTab(C, 'editor');
    expect(groupActiveTabIdOf(st(), 'editor')).toBe(A);
  });
});

describe('持久化与重启', () => {
  async function restart(): Promise<void> {
    const snap = snapshotFromStores();
    expect(ExplorerWritableSnapshotSchema.safeParse(snap).success).toBe(true);
    reset();
    await hydrateEditorTabs(snap, fsOf([A, B, C, D]));
  }

  it('单组:重启后关闭活动 tab 回到重启前最近使用的那个', async () => {
    open(A);
    open(B);
    open(C);
    open(D);
    st().switchTab(A);
    st().switchTab(D);
    await restart();
    expect(st().activeTabId).toBe(D);
    st().closeTab(D);
    expect(st().activeTabId).toBe(A);
  });

  it('多组:各组 MRU 随会话恢复', async () => {
    open(A);
    open(B);
    open(C);
    st().switchTab(A);
    st().switchTab(C);
    st().splitGroup('editor', 'editor:2', B);
    await restart();
    expect(groupActiveTabIdOf(st(), 'editor')).toBe(C);
    st().closeTab(C, 'editor');
    expect(groupActiveTabIdOf(st(), 'editor')).toBe(A);
  });

  it('MRU 与默认顺序一致时不写 mruPaths(旧形态不变)', () => {
    open(A);
    open(B);
    expect(snapshotFromStores().windows[0]!.editor).toEqual({ openFilePaths: [A, B], activePath: B });
    st().switchTab(A);
    st().switchTab(B);
    expect(snapshotFromStores().windows[0]!.editor).toEqual({ openFilePaths: [A, B], activePath: B });
  });

  it('与默认顺序不同时写 mruPaths', () => {
    open(A);
    open(B);
    open(C);
    st().switchTab(A);
    st().switchTab(C);
    expect(snapshotFromStores().windows[0]!.editor!.mruPaths).toEqual([C, A, B]);
  });
});
