import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ExplorerSchema,
  ExplorerSchemaV3,
  loadExplorer,
  migrateV1ToV2,
  migrateV2ToV3,
  saveExplorer,
  type ExplorerPayloadV3,
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
  it('完整 v2 对象 saveExplorer 后以 v3 读回', async () => {
    await saveExplorer(file, v2ValidPayload);
    const back = await loadExplorer(file);
    expect(back).toEqual(migrateV2ToV3(v2ValidPayload));
    const raw = JSON.parse(await readFile(file, 'utf-8')) as ExplorerPayloadV3;
    expect(raw.version).toBe(3);
  });

  it('缺失文件 → null(首次启动语义)', async () => {
    expect(await loadExplorer(file)).toBeNull();
  });

  // 边界(E15,E14 漏改的 v2 多行形式):legacy v2 schema 的 recentRoots/pinned 此前仍裸
  // z.array(z.string()),畸形 v2 文件可用超大数组绕过 v3 上限(loadExplorer 接受 v2 后 migrate
  // 原样搬到 v3)。v2 也须加 cap。
  it('E15 v2 schema recentRoots 超 1000 → fail', () => {
    const p = {
      ...v2ValidPayload,
      workspace: {
        recentRoots: Array.from({ length: 1001 }, (_, i) => `/r/${i}`),
      },
    };
    expect(ExplorerSchema.safeParse(p).success).toBe(false);
  });

  it('E15 v2 schema pinned.paths 超 10000 → fail', () => {
    const p = {
      ...v2ValidPayload,
      pinned: { paths: Array.from({ length: 10001 }, (_, i) => `/p/${i}`) },
    };
    expect(ExplorerSchema.safeParse(p).success).toBe(false);
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

  it('saveExplorer 拒绝非 v2/v3 schema 对象', async () => {
    await expect(saveExplorer(file, 'oops' as unknown)).rejects.toThrow();
    // v1 payload 直接 save 拒绝(必须先 migrateV1ToV2)
    await expect(saveExplorer(file, v1ValidPayload as unknown)).rejects.toThrow();
  });
});

describe('ExplorerSchemaV3', () => {
  it('v3 full schema 接受 main-owned layout / lastClosedAt 字段', () => {
    const v3 = migrateV2ToV3(v2ValidPayload);
    v3.windows[0] = {
      ...v3.windows[0]!,
      layout: { version: 1, dock: { panels: [] } },
      lastClosedAt: 123,
    };

    const parsed = ExplorerSchemaV3.parse(v3);

    expect(parsed.version).toBe(3);
    expect(parsed.windows[0]!.layout).toEqual({
      version: 1,
      dock: { panels: [] },
    });
    expect(parsed.windows[0]!.lastClosedAt).toBe(123);
  });

  // 边界(E14):路径数组/字符串无上限 → 损坏快照超大数组被接受致启动卡顿/内存峰值。schema 加 cap,
  // 超限 safeParse 失败(loadExplorer 视作损坏 → 降级默认)。cap 远超现实工作区,不破坏合法快照。
  describe('E14 数组/字符串上限', () => {
    // 深拷贝:migrateV2ToV3 与输入共享嵌套数组引用,直接 mutate 会污染 v2ValidPayload 致后续测试失败。
    const base = (): ExplorerPayloadV3 =>
      structuredClone(migrateV2ToV3(v2ValidPayload));

    it('正常规模 → ok', () => {
      expect(ExplorerSchemaV3.safeParse(base()).success).toBe(true);
    });

    it('recentRoots 超 1000 → fail', () => {
      const p = base();
      (p.workspace as { recentRoots: string[] }).recentRoots = Array.from(
        { length: 1001 },
        (_, i) => `/r/${i}`,
      );
      expect(ExplorerSchemaV3.safeParse(p).success).toBe(false);
    });

    it('expandedPaths 超 100000 → fail', () => {
      const p = base();
      (p.windows[0]!.explorer as { expandedPaths: string[] }).expandedPaths =
        Array.from({ length: 100001 }, (_, i) => `/e/${i}`);
      expect(ExplorerSchemaV3.safeParse(p).success).toBe(false);
    });

    it('单条路径串超 8192 → fail', () => {
      const p = base();
      (p.workspace as { recentRoots: string[] }).recentRoots = [
        '/' + 'x'.repeat(8192),
      ];
      expect(ExplorerSchemaV3.safeParse(p).success).toBe(false);
    });

    it('pinned.paths 超 10000 → fail', () => {
      const p = base();
      (p.pinned as { paths: string[] }).paths = Array.from(
        { length: 10001 },
        (_, i) => `/p/${i}`,
      );
      expect(ExplorerSchemaV3.safeParse(p).success).toBe(false);
    });
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

  it('loadExplorer 读到磁盘 v1 文件 → 自动迁移返 v3 形态', async () => {
    await writeFile(file, JSON.stringify(v1ValidPayload));
    const loaded = await loadExplorer(file);
    expect(loaded?.version).toBe(3);
    expect(loaded?.windows[0]?.workspace.root).toBe('/Users/me/work');
    expect(loaded?.workspace.recentRoots).toEqual(['/Users/me/work', '/Users/me/old']);
  });

  it('loadExplorer 读到磁盘 v2 文件 → 迁移返 v3', async () => {
    await writeFile(file, JSON.stringify(v2ValidPayload));
    const loaded = await loadExplorer(file);
    expect(loaded).toEqual(migrateV2ToV3(v2ValidPayload));
  });

  it('loadExplorer 未知 version(既非 v1 也非 v2) → null', async () => {
    await writeFile(file, JSON.stringify({ version: 99, garbage: true }));
    expect(await loadExplorer(file)).toBeNull();
  });
});
