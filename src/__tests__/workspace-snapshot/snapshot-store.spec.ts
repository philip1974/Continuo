// BDD: workspace-snapshot / 快照表(explorer.json 顶层 workspaceSnapshots,main-owned)。
// VSCode workspace storage:状态按文件夹保存;这里按 root 索引、最近使用在前、最多 20 个。
import { describe, expect, it } from 'vitest';
import {
  findWorkspaceSnapshot,
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
