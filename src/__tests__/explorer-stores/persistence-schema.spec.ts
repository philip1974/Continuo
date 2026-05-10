import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ExplorerSchema,
  loadExplorer,
  migrateV1ToV2,
  saveExplorer,
  type ExplorerV1Payload,
} from '../../../electron/main/persistence';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lm-explorer-'));
  file = path.join(dir, 'explorer.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// v2 完整 payload(单窗口)
const v2ValidPayload = {
  version: 2 as const,
  workspace: { recentRoots: ['/Users/me/work', '/Users/me/old'] },
  pinned: { paths: ['/Users/me/work/important.md'] },
  nextWindowSeq: 1,
  windows: [
    {
      windowSeq: 0,
      workspace: { root: '/Users/me/work' },
      explorer: {
        activePath: '/Users/me/work/file.md',
        expandedPaths: ['/Users/me/work', '/Users/me/work/sub'],
        sort: { by: 'name' as const, reverse: false },
      },
    },
  ],
};

// v1 完整 payload(向后兼容,文件可读但内存返 v2)
const v1ValidPayload: ExplorerV1Payload = {
  version: 1,
  workspace: {
    root: '/Users/me/work',
    recentRoots: ['/Users/me/work', '/Users/me/old'],
  },
  explorer: {
    activePath: '/Users/me/work/file.md',
    expandedPaths: ['/Users/me/work', '/Users/me/work/sub'],
    sort: { by: 'name', reverse: false },
  },
  pinned: { paths: ['/Users/me/work/important.md'] },
};

describe('ExplorerSchema v2', () => {
  it('完整 v2 对象 round-trip', async () => {
    await saveExplorer(file, v2ValidPayload);
    const back = await loadExplorer(file);
    expect(back).toEqual(v2ValidPayload);
  });

  it('缺失文件 → null(首次启动语义)', async () => {
    expect(await loadExplorer(file)).toBeNull();
  });

  it('损坏 JSON → null,不抛', async () => {
    await writeFile(file, '{not json');
    expect(await loadExplorer(file)).toBeNull();
  });

  it('schema 拒绝 version !== 2', () => {
    expect(() =>
      ExplorerSchema.parse({ ...v2ValidPayload, version: 3 }),
    ).toThrow();
  });

  it('schema 拒绝缺顶层字段(无 windows / nextWindowSeq)', () => {
    expect(() =>
      ExplorerSchema.parse({
        version: 2,
        workspace: { recentRoots: [] },
        pinned: { paths: [] },
      }),
    ).toThrow();
  });

  it('schema 拒绝未知顶层字段(strict)', () => {
    expect(() =>
      ExplorerSchema.parse({ ...v2ValidPayload, weird: true }),
    ).toThrow();
  });

  it('schema 拒绝非合法 sort.by', () => {
    expect(() =>
      ExplorerSchema.parse({
        ...v2ValidPayload,
        windows: [
          {
            ...v2ValidPayload.windows[0]!,
            explorer: {
              ...v2ValidPayload.windows[0]!.explorer,
              sort: { by: 'random', reverse: false },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('windows[].layoutUi 可选(无则缺失)', () => {
    const ok = ExplorerSchema.parse(v2ValidPayload);
    expect(ok.windows[0]!.layoutUi).toBeUndefined();
  });

  it('windows[].layoutUi 提供:接受合法值', () => {
    const ok = ExplorerSchema.parse({
      ...v2ValidPayload,
      windows: [
        {
          ...v2ValidPayload.windows[0]!,
          layoutUi: { sidebarOpen: false, sidebarWidth: 320 },
        },
      ],
    });
    expect(ok.windows[0]!.layoutUi).toEqual({
      sidebarOpen: false,
      sidebarWidth: 320,
    });
  });

  it('windows[].workspace.root 允许 null(空 workspace 窗口)', () => {
    const ok = ExplorerSchema.parse({
      ...v2ValidPayload,
      windows: [
        {
          ...v2ValidPayload.windows[0]!,
          workspace: { root: null },
        },
      ],
    });
    expect(ok.windows[0]!.workspace.root).toBeNull();
  });

  it('多 windows 段共存', () => {
    const ok = ExplorerSchema.parse({
      ...v2ValidPayload,
      nextWindowSeq: 2,
      windows: [
        v2ValidPayload.windows[0]!,
        {
          windowSeq: 1,
          workspace: { root: '/proj/B' },
          explorer: {
            activePath: null,
            expandedPaths: [],
            sort: { by: 'name', reverse: false },
          },
        },
      ],
    });
    expect(ok.windows).toHaveLength(2);
    expect(ok.windows[1]!.windowSeq).toBe(1);
  });

  it('saveExplorer 拒绝非 v2 schema 对象', async () => {
    await expect(saveExplorer(file, 'oops' as unknown)).rejects.toThrow();
    // v1 payload 直接 save 拒绝(必须先 migrateV1ToV2)
    await expect(saveExplorer(file, v1ValidPayload as unknown)).rejects.toThrow();
  });
});

describe('migrateV1ToV2', () => {
  it('v1 完整对象 → v2 单窗段(windowSeq=0,nextWindowSeq=1)', () => {
    const v2 = migrateV1ToV2(v1ValidPayload);
    expect(v2.version).toBe(2);
    expect(v2.workspace.recentRoots).toEqual(v1ValidPayload.workspace.recentRoots);
    expect(v2.pinned.paths).toEqual(v1ValidPayload.pinned.paths);
    expect(v2.nextWindowSeq).toBe(1);
    expect(v2.windows).toHaveLength(1);
    expect(v2.windows[0]).toEqual({
      windowSeq: 0,
      workspace: { root: '/Users/me/work' },
      explorer: v1ValidPayload.explorer,
    });
  });

  it('v1 含 layoutUi / editor → v2 windows[0] 保留', () => {
    const v1 = {
      ...v1ValidPayload,
      layoutUi: { sidebarOpen: false, sidebarWidth: 320 },
      editor: {
        openFilePaths: ['/x.md', '/y.md'],
        activePath: '/x.md',
      },
    };
    const v2 = migrateV1ToV2(v1);
    expect(v2.windows[0]!.layoutUi).toEqual(v1.layoutUi);
    expect(v2.windows[0]!.editor).toEqual(v1.editor);
  });

  it('v1 root=null → v2 windows[0].workspace.root=null', () => {
    const v1 = {
      ...v1ValidPayload,
      workspace: { root: null, recentRoots: [] },
    };
    const v2 = migrateV1ToV2(v1);
    expect(v2.windows[0]!.workspace.root).toBeNull();
  });

  it('loadExplorer 读到磁盘 v1 文件 → 自动迁移返 v2 形态', async () => {
    await writeFile(file, JSON.stringify(v1ValidPayload));
    const loaded = await loadExplorer(file);
    expect(loaded?.version).toBe(2);
    expect(loaded?.windows[0]?.workspace.root).toBe('/Users/me/work');
    expect(loaded?.workspace.recentRoots).toEqual(['/Users/me/work', '/Users/me/old']);
  });

  it('loadExplorer 读到磁盘 v2 文件 → 直接返 v2', async () => {
    await writeFile(file, JSON.stringify(v2ValidPayload));
    const loaded = await loadExplorer(file);
    expect(loaded).toEqual(v2ValidPayload);
  });

  it('loadExplorer 未知 version(既非 v1 也非 v2) → null', async () => {
    await writeFile(file, JSON.stringify({ version: 99, garbage: true }));
    expect(await loadExplorer(file)).toBeNull();
  });
});
