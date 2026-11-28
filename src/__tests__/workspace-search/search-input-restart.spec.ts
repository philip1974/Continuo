// @vitest-environment jsdom
// BDD: workspace-search / 8 搜索输入跨重启恢复(VSCode SearchView 把查询 / 正则 / 大小写 / 全词 / 包含排除 / 详情展开存进
// 视图状态,重启后恢复输入,不自动重搜):随 explorer.json 的窗口段持久化,按窗口独立,旧数据无字段 → 保持空。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ start: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    search: {
      start: h.start,
      cancel: vi.fn(async () => ({ ok: true })),
      onEvent: () => () => {},
    },
  },
}));
vi.mock('@/plugins/co-app', () => ({ coApp: { editor: { openFile: vi.fn() } } }));

import { useWorkspaceStore } from '@/stores/workspace.store';
import { useEditorStore } from '@/stores/editor.store';
import { __resetSearchForTest, SEARCH_DEBOUNCE_MS, useSearchStore } from '@/panels/Search/search-store';
import {
  hydrateStores,
  initExplorerPersistence,
  snapshotFromStores,
  type ExplorerPersistApi,
  type ExplorerSnapshot,
} from '@/lib/persist/explorer-persist';
import {
  ExplorerSchemaV3,
  ExplorerWritableSnapshotSchema,
} from '../../../electron/shared/explorer-persistence-schema';
import { SEARCH_GLOB_MAX, SEARCH_PATTERN_MAX } from '../../../electron/shared/workspace-search';

type WindowSearch = NonNullable<ExplorerSnapshot['windows'][number]['search']>;

function snapWith(search: WindowSearch | undefined, windowSeq = 0): ExplorerSnapshot {
  return {
    version: 3,
    workspace: { recentRoots: [] },
    pinned: { paths: [] },
    nextWindowSeq: windowSeq + 1,
    windows: [
      {
        windowSeq,
        workspace: { root: '/w' },
        explorer: { activePath: null, expandedPaths: [], sort: { by: 'name', reverse: false } },
        ...(search === undefined ? null : { search }),
      },
    ],
  };
}

beforeEach(() => {
  useWorkspaceStore.setState({ root: '/w' });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});
afterEach(() => {
  vi.useRealTimers();
  __resetSearchForTest();
  useWorkspaceStore.setState({ root: null });
  h.start.mockClear();
});

describe('写入窗口段', () => {
  it('默认输入 → 窗口段不带 search 字段(旧形态不变)', () => {
    expect(snapshotFromStores().windows[0]).not.toHaveProperty('search');
  });

  it('查询词 / 开关 / 包含排除 / 详情展开写进本窗口段,只写非默认项,快照通过磁盘 schema', () => {
    const s = useSearchStore.getState();
    s.setPattern('foo bar');
    s.toggleOption('matchCase');
    s.setInclude('src');
    s.toggleDetails();
    const snap = snapshotFromStores(undefined, 2);
    expect(snap.windows).toHaveLength(1);
    expect(snap.windows[0]!.windowSeq).toBe(2);
    expect(snap.windows[0]!.search).toEqual({ pattern: 'foo bar', matchCase: true, include: 'src', detailsOpen: true });
    expect(ExplorerWritableSnapshotSchema.safeParse(snap).success).toBe(true);
  });

  it('输入变化经窗口段的去抖写盘落盘(复用 explorer 持久化的写入时机)', async () => {
    const api: ExplorerPersistApi = {
      read: vi.fn(async () => ({ ok: true as const, data: null })),
      write: vi.fn(async () => ({ ok: true as const, data: undefined })),
    };
    await initExplorerPersistence(api);
    vi.useFakeTimers();
    useSearchStore.getState().setPattern('needle');
    useSearchStore.getState().toggleOption('wholeWord');
    await vi.advanceTimersByTimeAsync(1000);
    const calls = (api.write as ReturnType<typeof vi.fn>).mock.calls;
    const last = calls[calls.length - 1]![0] as ExplorerSnapshot;
    expect(last.windows[0]!.search).toEqual({ pattern: 'needle', wholeWord: true });
  });
});

describe('重启恢复', () => {
  it('按本窗口段恢复查询与选项,不自动重搜,结果为空', async () => {
    vi.useFakeTimers();
    hydrateStores(snapWith({ pattern: 'foo bar', matchCase: true, isRegex: true, exclude: 'dist', detailsOpen: true }));
    const s = useSearchStore.getState();
    expect(s).toMatchObject({
      pattern: 'foo bar',
      matchCase: true,
      isRegex: true,
      wholeWord: false,
      include: '',
      exclude: 'dist',
      detailsOpen: true,
      status: 'idle',
      files: [],
    });
    // 恢复后工作区根再变化(启动期 root 恢复晚于面板挂载)也不重搜:恢复出的输入还没搜过
    useWorkspaceStore.setState({ root: '/w2' });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 3);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('只取本窗口的段:别的 windowSeq 的段不影响本窗', () => {
    hydrateStores(snapWith({ pattern: 'other' }, 3), 0);
    expect(useSearchStore.getState().pattern).toBe('');
  });

  it('旧数据(窗口段无 search 字段)→ 输入保持空,选项默认', () => {
    hydrateStores(snapWith(undefined));
    expect(useSearchStore.getState()).toMatchObject({
      pattern: '',
      isRegex: false,
      matchCase: false,
      wholeWord: false,
      include: '',
      exclude: '',
      detailsOpen: false,
    });
  });

  it('恢复后用户编辑查询 → 照常去抖搜索', async () => {
    vi.useFakeTimers();
    hydrateStores(snapWith({ pattern: 'foo' }));
    useSearchStore.getState().setPattern('foo2');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10);
    expect(h.start).toHaveBeenCalledTimes(1);
  });
});

describe('长度上限', () => {
  it('磁盘 schema 拒超长查询词 / glob(损坏快照降级默认,与其它字段同一策略)', () => {
    expect(ExplorerSchemaV3.safeParse(snapWith({ pattern: 'a'.repeat(SEARCH_PATTERN_MAX) })).success).toBe(true);
    expect(ExplorerSchemaV3.safeParse(snapWith({ pattern: 'a'.repeat(SEARCH_PATTERN_MAX + 1) })).success).toBe(false);
    expect(ExplorerSchemaV3.safeParse(snapWith({ pattern: '', include: 'a'.repeat(SEARCH_GLOB_MAX + 1) })).success).toBe(false);
  });

  it('运行时写出的查询词不超过上限(超长粘贴被截断后仍能写盘)', () => {
    useSearchStore.getState().setPattern('x'.repeat(SEARCH_PATTERN_MAX * 3));
    const snap = snapshotFromStores();
    expect(snap.windows[0]!.search!.pattern).toHaveLength(SEARCH_PATTERN_MAX);
    expect(ExplorerWritableSnapshotSchema.safeParse(snap).success).toBe(true);
  });
});
