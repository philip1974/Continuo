// BDD: workspace-snapshot / 快照表(explorer.json 顶层 workspaceSnapshots,main-owned)。
// VSCode workspace storage:状态按文件夹保存;这里按 root 索引、最近使用在前、最多 20 个。
import { describe, expect, it } from 'vitest';
import {
  findWorkspaceSnapshot,
  scopeWorkspaceSnapshot,
  snapshotOfWindowEntry,
  upsertWorkspaceSnapshot,
  WORKSPACE_SNAPSHOT_MAX_BYTES,
} from '../../../electron/main/services/workspace-snapshot.service';
import { mergeWritableIntoFull } from '../../../electron/main/persistence';
import {
  ExplorerSchemaV3,
  ExplorerWritableSnapshotSchema,
  WORKSPACE_SNAPSHOTS_LIMIT,
  WorkspaceSwitchInputSchema,
  type ExplorerPayloadV3,
  type WindowEntryV3,
  type WorkspaceSnapshot,
} from '../../../electron/shared/explorer-persistence-schema';

const SORT = { by: 'name', reverse: false } as const;

function snap(root: string, extra: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    workspace: { root },
    explorer: { activePath: null, expandedPaths: [], sort: SORT },
    editor: { openFilePaths: [`${root}/a.ts`], activePath: `${root}/a.ts` },
    ...extra,
  };
}

function payload(over: Partial<ExplorerPayloadV3> = {}): ExplorerPayloadV3 {
  return {
    version: 3,
    workspace: { recentRoots: [] },
    pinned: { paths: [] },
    nextWindowSeq: 1,
    windows: [],
    ...over,
  };
}

// 测试里不碰真实文件系统:realpath 由表驱动(软链 → 目标),其余原样。
const links: Record<string, string> = { '/link/ws2': '/real/ws2' };
const deps = {
  realpath: async (p: string): Promise<string> => links[p] ?? p,
  platform: 'darwin' as const,
};

describe('窗口段 → 快照', () => {
  it('取工作区相关部分(展开 / 侧栏 / 编辑器 / 搜索 / dock 布局),不含 windowSeq / 几何 / lastClosedAt', () => {
    const entry: WindowEntryV3 = {
      windowSeq: 3,
      workspace: { root: '/ws2' },
      explorer: { activePath: null, expandedPaths: ['/ws2/src'], sort: SORT },
      layoutUi: { sidebarOpen: false, sidebarWidth: 300 },
      editor: {
        openFilePaths: ['/ws2/w1.ts'],
        activePath: '/ws2/w1.ts',
        viewStates: [{ path: '/ws2/w1.ts', selection: { anchor: 1, head: 1 }, folds: [{ from: 0, to: 4 }] }],
      },
      search: { pattern: 'todo' },
      layout: { version: 1, grid: {} },
      lastClosedAt: 5,
      windowState: { bounds: { x: 0, y: 0, width: 800, height: 600 } },
      // popout 子窗的最大化 / 全屏属于窗口(同 windowState),不进快照
      popoutWindowModes: [{ id: '2', mode: 'maximized', position: { left: 1, top: 2, width: 500, height: 400 } }],
    };
    expect(snapshotOfWindowEntry(entry)).toEqual({
      workspace: { root: '/ws2' },
      explorer: entry.explorer,
      layoutUi: entry.layoutUi,
      editor: entry.editor,
      search: entry.search,
      layout: entry.layout,
    });
  });

  it('没有 root 的段(空窗口)不产生快照', () => {
    expect(
      snapshotOfWindowEntry({
        windowSeq: 1,
        workspace: { root: null },
        explorer: { activePath: null, expandedPaths: [], sort: SORT },
      }),
    ).toBeNull();
  });
});

// VSCode workspace storage 只记属于该文件夹的编辑器。同一窗口切走时按设计保留的未保存 tab(别的文件夹的文件)不能记进
// 当前文件夹的快照,否则在新窗口打开该文件夹会把别的项目的文件带进来(同一文件在两个窗口同时打开)。
describe('快照只含属于该文件夹的路径', () => {
  const base = { explorer: { activePath: null, expandedPaths: [] as string[], sort: SORT } };

  it('单组:tab / 活动 / MRU / 视图状态 / 展开里 root 外的路径剔除(同名前缀的兄弟目录不算在内);活动文件被剔除 → 降级为 MRU 中下一个', () => {
    const s = scopeWorkspaceSnapshot({
      workspace: { root: '/ws3' },
      explorer: { activePath: '/ws1/x', expandedPaths: ['/ws3/src', '/ws1/src', '/ws30/src'], sort: SORT },
      editor: {
        openFilePaths: ['/ws3/b.ts', '/ws1/file-1.ts', '/ws3/c.ts', '/ws30/d.ts'],
        activePath: '/ws1/file-1.ts',
        mruPaths: ['/ws1/file-1.ts', '/ws3/c.ts', '/ws30/d.ts', '/ws3/b.ts'],
        viewStates: [
          { path: '/ws1/file-1.ts', topLine: 3, selection: { anchor: 0, head: 0 } },
          { path: '/ws3/c.ts', topLine: 5, selection: { anchor: 1, head: 1 } },
        ],
      },
    });
    expect(s).toEqual({
      workspace: { root: '/ws3' },
      explorer: { activePath: null, expandedPaths: ['/ws3/src'], sort: SORT },
      editor: {
        openFilePaths: ['/ws3/b.ts', '/ws3/c.ts'],
        activePath: '/ws3/c.ts',
        mruPaths: ['/ws3/c.ts', '/ws3/b.ts'],
        viewStates: [{ path: '/ws3/c.ts', topLine: 5, selection: { anchor: 1, head: 1 } }],
      },
    });
  });

  it('没有 MRU 记录时活动文件被剔除 → 降级为剩下的最后一个 tab(与默认 MRU 顺序一致)', () => {
    const s = scopeWorkspaceSnapshot({
      ...base,
      workspace: { root: '/ws3' },
      editor: { openFilePaths: ['/ws3/a.ts', '/ws3/b.ts', '/ws1/x.ts'], activePath: '/ws1/x.ts' },
    });
    expect(s.editor).toEqual({ openFilePaths: ['/ws3/a.ts', '/ws3/b.ts'], activePath: '/ws3/b.ts' });
  });

  it('全是别的文件夹的 tab → 编辑器为空、活动为 null,不留 MRU / 视图状态', () => {
    const s = scopeWorkspaceSnapshot({
      ...base,
      workspace: { root: '/ws3' },
      editor: {
        openFilePaths: ['/ws1/a.ts', '/ws1/b.ts'],
        activePath: '/ws1/a.ts',
        mruPaths: ['/ws1/a.ts', '/ws1/b.ts'],
        viewStates: [{ path: '/ws1/a.ts', topLine: 2 }],
        mode: 'edit',
      },
    });
    expect(s.editor).toEqual({ openFilePaths: [], activePath: null, mode: 'edit' });
  });

  it('多组:各组剔除 root 外的 tab;变空的组丢弃,活动组被丢弃 → 降级为剩下的第一个组', () => {
    const s = scopeWorkspaceSnapshot({
      ...base,
      workspace: { root: '/ws3' },
      editor: {
        openFilePaths: ['/ws1/a.ts', '/ws3/b.ts', '/ws3/c.ts'],
        activePath: '/ws1/a.ts',
        groups: [
          { id: 'editor', openFilePaths: ['/ws1/a.ts'], activePath: '/ws1/a.ts' },
          { id: 'editor-2', openFilePaths: ['/ws3/b.ts', '/ws1/a.ts'], activePath: '/ws1/a.ts', mruPaths: ['/ws1/a.ts', '/ws3/b.ts'] },
          { id: 'editor-3', openFilePaths: ['/ws3/c.ts'], activePath: '/ws3/c.ts' },
        ],
        activeGroup: 'editor',
        viewStates: [
          { path: '/ws3/b.ts', group: 'editor-2', topLine: 4 },
          { path: '/ws1/a.ts', group: 'editor', topLine: 9 },
        ],
      },
    });
    expect(s.editor).toEqual({
      openFilePaths: ['/ws3/b.ts', '/ws3/c.ts'],
      activePath: '/ws3/b.ts',
      groups: [
        { id: 'editor-2', openFilePaths: ['/ws3/b.ts'], activePath: '/ws3/b.ts' },
        { id: 'editor-3', openFilePaths: ['/ws3/c.ts'], activePath: '/ws3/c.ts' },
      ],
      activeGroup: 'editor-2',
      viewStates: [{ path: '/ws3/b.ts', group: 'editor-2', topLine: 4 }],
    });
  });

  it('多组剔除后只剩一个组 → 写回单组形态(不带 groups / activeGroup,MRU 归顶层)', () => {
    const s = scopeWorkspaceSnapshot({
      ...base,
      workspace: { root: '/ws3' },
      editor: {
        openFilePaths: ['/ws1/a.ts', '/ws3/b.ts', '/ws3/c.ts'],
        activePath: '/ws1/a.ts',
        groups: [
          { id: 'editor', openFilePaths: ['/ws1/a.ts'], activePath: '/ws1/a.ts' },
          { id: 'editor-2', openFilePaths: ['/ws3/b.ts', '/ws3/c.ts'], activePath: '/ws3/c.ts', mruPaths: ['/ws3/c.ts', '/ws3/b.ts'] },
        ],
        activeGroup: 'editor',
      },
    });
    expect(s.editor).toEqual({
      openFilePaths: ['/ws3/b.ts', '/ws3/c.ts'],
      activePath: '/ws3/c.ts',
      mruPaths: ['/ws3/c.ts', '/ws3/b.ts'],
    });
  });

  it('全在 root 内 → 内容不变', () => {
    const input: WorkspaceSnapshot = snap('/ws3', {
      explorer: { activePath: null, expandedPaths: ['/ws3/src'], sort: SORT },
      editor: {
        openFilePaths: ['/ws3/a.ts', '/ws3/b.ts'],
        activePath: '/ws3/a.ts',
        mruPaths: ['/ws3/a.ts', '/ws3/b.ts'],
        viewStates: [{ path: '/ws3/a.ts', topLine: 2 }],
      },
    });
    expect(scopeWorkspaceSnapshot(input)).toEqual(input);
  });

  it('窗口段转快照、写入快照表(含同一窗口切换的 save)、从快照表取出都只含 root 内路径', async () => {
    const entry: WindowEntryV3 = {
      windowSeq: 1,
      workspace: { root: '/ws3' },
      ...base,
      editor: { openFilePaths: ['/ws3/b.ts', '/ws1/file-1.ts'], activePath: '/ws1/file-1.ts' },
    };
    expect(snapshotOfWindowEntry(entry)?.editor).toEqual({ openFilePaths: ['/ws3/b.ts'], activePath: '/ws3/b.ts' });

    const p = payload();
    await upsertWorkspaceSnapshot(
      p,
      { workspace: { root: '/ws3' }, ...base, editor: { openFilePaths: ['/ws1/file-1.ts'], activePath: '/ws1/file-1.ts' } },
      deps,
    );
    expect(p.workspaceSnapshots?.[0]?.editor).toEqual({ openFilePaths: [], activePath: null });

    // 旧版本写下的快照(带了别的文件夹的 tab)→ 取出时同样剔除
    const old = payload({
      workspaceSnapshots: [{ workspace: { root: '/ws3' }, ...base, editor: { openFilePaths: ['/ws1/x.ts'], activePath: '/ws1/x.ts' } }],
    });
    expect((await findWorkspaceSnapshot(old, '/ws3', deps))?.editor).toEqual({ openFilePaths: [], activePath: null });
  });
});

describe('写入 / 查找', () => {
  it('新写入的放在最前;同一 root 再写替换原条目并置顶', async () => {
    const p = payload();
    expect(await upsertWorkspaceSnapshot(p, snap('/a'), deps)).toBe(true);
    await upsertWorkspaceSnapshot(p, snap('/b'), deps);
    const a2 = snap('/a', { search: { pattern: 'x' } });
    await upsertWorkspaceSnapshot(p, a2, deps);
    expect(p.workspaceSnapshots?.map((s) => s.workspace.root)).toEqual(['/a', '/b']);
    expect(p.workspaceSnapshots?.[0]).toEqual(a2);
  });

  it('内容与位置都没变 → 返回 false(调用方不写盘)', async () => {
    const p = payload({ workspaceSnapshots: [snap('/a'), snap('/b')] });
    expect(await upsertWorkspaceSnapshot(p, snap('/a'), deps)).toBe(false);
  });

  it(`超过 ${WORKSPACE_SNAPSHOTS_LIMIT} 个文件夹 → 淘汰最久没用的`, async () => {
    const p = payload();
    for (let i = 0; i < WORKSPACE_SNAPSHOTS_LIMIT + 3; i++) await upsertWorkspaceSnapshot(p, snap(`/w${i}`), deps);
    expect(p.workspaceSnapshots).toHaveLength(WORKSPACE_SNAPSHOTS_LIMIT);
    expect(p.workspaceSnapshots?.[0]?.workspace.root).toBe(`/w${WORKSPACE_SNAPSHOTS_LIMIT + 2}`);
    expect(p.workspaceSnapshots?.some((s) => s.workspace.root === '/w0')).toBe(false);
  });

  it('root 比较先 realpath、再按平台语义(软链 / 尾分隔符视为同一文件夹;子目录不是)', async () => {
    const p = payload({ workspaceSnapshots: [snap('/real/ws2'), snap('/other')] });
    expect((await findWorkspaceSnapshot(p, '/link/ws2', deps))?.workspace.root).toBe('/real/ws2');
    expect((await findWorkspaceSnapshot(p, '/other/', deps))?.workspace.root).toBe('/other');
    expect(await findWorkspaceSnapshot(p, '/other/sub', deps)).toBeNull();
    // 经软链再存 → 替换同一条,不出现两份
    await upsertWorkspaceSnapshot(p, snap('/link/ws2'), deps);
    expect(p.workspaceSnapshots?.map((s) => s.workspace.root)).toEqual(['/link/ws2', '/other']);
  });

  it('Windows 大小写不敏感', async () => {
    const p = payload({ workspaceSnapshots: [snap('C:\\Code\\Proj')] });
    const found = await findWorkspaceSnapshot(p, 'c:\\code\\proj', { realpath: async (x) => x, platform: 'win32' });
    expect(found?.workspace.root).toBe('C:\\Code\\Proj');
  });

  it(`单个快照序列化超过 ${WORKSPACE_SNAPSHOT_MAX_BYTES} 字节不存,并移除该 root 的旧快照`, async () => {
    const p = payload({ workspaceSnapshots: [snap('/a'), snap('/b')] });
    const huge = snap('/a', { layout: { version: 1, blob: 'x'.repeat(WORKSPACE_SNAPSHOT_MAX_BYTES) } });
    expect(await upsertWorkspaceSnapshot(p, huge, deps)).toBe(true);
    expect(p.workspaceSnapshots?.map((s) => s.workspace.root)).toEqual(['/b']);
  });
});

describe('磁盘契约', () => {
  it('完整 schema 接受快照表;renderer 可写 schema 不接受(main-owned)', () => {
    const full = payload({ workspaceSnapshots: [snap('/a', { layout: { version: 1 } })] });
    expect(ExplorerSchemaV3.safeParse(full).success).toBe(true);
    expect(ExplorerWritableSnapshotSchema.safeParse(full).success).toBe(false);
  });

  it('切换 IPC 的入参:save 不能带 layout(布局只取盘上本窗段)', () => {
    const { layout: _l, ...noLayout } = snap('/a', { layout: { version: 1 } });
    expect(WorkspaceSwitchInputSchema.safeParse({ save: noLayout, open: '/b' }).success).toBe(true);
    expect(WorkspaceSwitchInputSchema.safeParse({ save: null, open: null }).success).toBe(true);
    expect(
      WorkspaceSwitchInputSchema.safeParse({ save: snap('/a', { layout: { version: 1 } }), open: '/b' }).success,
    ).toBe(false);
  });

  it('renderer 整份写回(explorer:write 合并)保留盘上的快照表', () => {
    const current = payload({ workspaceSnapshots: [snap('/a')] });
    const merged = mergeWritableIntoFull(current, {
      version: 3,
      workspace: { recentRoots: [] },
      pinned: { paths: [] },
      nextWindowSeq: 1,
      windows: [
        { windowSeq: 0, workspace: { root: '/b' }, explorer: { activePath: null, expandedPaths: [], sort: SORT } },
      ],
    });
    expect(merged.workspaceSnapshots).toEqual([snap('/a')]);
  });
});
