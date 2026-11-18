import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  defaultExplorerV3,
  loadExplorer,
  migrateExplorerFileToV3,
  prepareExplorerFileForBoot,
  saveExplorer,
  type ExplorerPayload,
} from '../../../electron/main/persistence';

let dir: string;
let explorerFile: string;
let legacyLayoutFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'continuo-migrate-v3-'));
  explorerFile = path.join(dir, 'explorer.json');
  legacyLayoutFile = path.join(dir, 'layout.json');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const v2Payload: ExplorerPayload = {
  version: 2,
  workspace: { recentRoots: ['/work'] },
  pinned: { paths: ['/work/pinned.md'] },
  nextWindowSeq: 2,
  windows: [
    {
      windowSeq: 0,
      workspace: { root: '/work' },
      explorer: {
        activePath: '/work/a.md',
        expandedPaths: ['/work'],
        sort: { by: 'name', reverse: false },
      },
    },
  ],
};

describe('migrateExplorerFileToV3 edge paths', () => {
  it('T11: no explorer.json and no legacy layout.json is a no-op', async () => {
    await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

    expect(existsSync(explorerFile)).toBe(false);
    expect(existsSync(legacyLayoutFile)).toBe(false);
  });

  it('T11: layout-only path creates default v3 explorer and removes legacy layout', async () => {
    await fs.writeFile(legacyLayoutFile, JSON.stringify({ version: 1, panels: {} }));

    await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

    expect(await loadExplorer(explorerFile)).toEqual(defaultExplorerV3());
    expect(existsSync(legacyLayoutFile)).toBe(false);
  });

  it('T11: v2-only explorer path rewrites explorer.json as v3', async () => {
    await fs.writeFile(explorerFile, JSON.stringify(v2Payload));

    await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

    const migrated = await loadExplorer(explorerFile);
    expect(migrated?.version).toBe(3);
    expect(migrated?.windows[0]?.workspace.root).toBe('/work');
    const raw = JSON.parse(await fs.readFile(explorerFile, 'utf-8')) as { version: number };
    expect(raw.version).toBe(3);
  });

  it('T11: mixed explorer plus legacy layout rewrites v3 and removes legacy layout', async () => {
    await fs.writeFile(explorerFile, JSON.stringify(v2Payload));
    await fs.writeFile(legacyLayoutFile, JSON.stringify({ version: 1, panels: {} }));

    await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

    const migrated = await loadExplorer(explorerFile);
    expect(migrated?.version).toBe(3);
    expect(migrated?.windows[0]?.workspace.root).toBe('/work');
    expect(existsSync(legacyLayoutFile)).toBe(false);
  });

  it('T11: corrupt explorer.json skips migration and keeps legacy layout for manual recovery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fs.writeFile(explorerFile, '{not json');
    await fs.writeFile(legacyLayoutFile, JSON.stringify({ version: 1 }));

    await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

    expect(warn).toHaveBeenCalled();
    expect(await fs.readFile(explorerFile, 'utf-8')).toBe('{not json');
    expect(existsSync(legacyLayoutFile)).toBe(true);
  });

  // 数据安全(codex 复查 P1):explorer.json access EACCES(存在但不可读)+ legacy 存在时,
  // fileExists 此前当「不存在」→ 进入「写默认 + 删 legacy」分支,抹掉 recentRoots/pinned/
  // window 段。只 ENOENT 算不存在;access 错误跳过迁移(不写不删)。
  it('T12: explorer.json access EACCES → 跳过迁移,不写默认覆盖、不删 legacy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fs.writeFile(
      explorerFile,
      '{"version":3,"SENTINEL":"keep","nextWindowSeq":5,"windows":[]}',
    );
    await fs.writeFile(legacyLayoutFile, JSON.stringify({ version: 1 }));

    const realAccess = fs.access.bind(fs);
    vi.spyOn(fs, 'access').mockImplementation(
      async (p: Parameters<typeof realAccess>[0], ...rest: unknown[]) => {
        if (String(p) === explorerFile) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        return (realAccess as (...a: unknown[]) => Promise<void>)(p, ...rest);
      },
    );

    await migrateExplorerFileToV3(explorerFile, legacyLayoutFile);

    expect(warn).toHaveBeenCalled();
    // explorer.json 未被默认覆盖(SENTINEL 仍在),legacy 未删
    expect(await fs.readFile(explorerFile, 'utf-8')).toContain('SENTINEL');
    expect(existsSync(legacyLayoutFile)).toBe(true);
  });
});

// 冷启动性能:常规启动(explorer.json 已是 v3、无旧 layout.json)建窗前只应读 + 解析 explorer.json
// 一次(此前 migrate 读一次、判断是否 v3 又读一次、prune 再读一次 = 3 次)。
describe('prepareExplorerFileForBoot(启动迁移 + 段数收敛单次加载)', () => {
  function countExplorerOpens(): { count: () => number } {
    let n = 0;
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(
      (async (p: Parameters<typeof realOpen>[0], ...rest: unknown[]) => {
        if (String(p) === explorerFile) n += 1;
        return (realOpen as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      }) as typeof fs.open,
    );
    return { count: () => n };
  }

  it('常规 v3 启动:explorer.json 只读一次,且不写盘', async () => {
    await saveExplorer(explorerFile, defaultExplorerV3());
    const before = await fs.stat(explorerFile);
    const opens = countExplorerOpens();

    await prepareExplorerFileForBoot(explorerFile, legacyLayoutFile, 64, new Set([0]));

    expect(opens.count()).toBe(1);
    expect((await fs.stat(explorerFile)).ino).toBe(before.ino);
  });

  it('v3 超长文件:单次读完成收敛写盘', async () => {
    const payload = defaultExplorerV3();
    payload.windows = [
      payload.windows[0]!,
      ...Array.from({ length: 80 }, (_, i) => ({
        windowSeq: i + 1,
        workspace: { root: `/w${i + 1}` },
        explorer: { activePath: null, expandedPaths: [], sort: { by: 'name' as const, reverse: false } },
        lastClosedAt: 1000 + i,
      })),
    ];
    payload.nextWindowSeq = 100;
    await saveExplorer(explorerFile, payload);
    const opens = countExplorerOpens();

    await prepareExplorerFileForBoot(explorerFile, legacyLayoutFile, 64, new Set([0]));

    expect(opens.count()).toBe(1);
    vi.restoreAllMocks();
    const after = (await loadExplorer(explorerFile))!;
    expect(after.windows).toHaveLength(64);
    expect(after.windows[0]!.windowSeq).toBe(0);
    expect(after.nextWindowSeq).toBe(100);
  });

  it('启动收敛不摘缺 lastClosedAt 的段(上次会话退出/崩溃时仍开着的窗口),摘有时间戳的最旧段', async () => {
    const sort = { by: 'name' as const, reverse: false };
    const payload = defaultExplorerV3();
    payload.windows = [
      payload.windows[0]!,
      ...Array.from({ length: 70 }, (_, i) => ({
        windowSeq: i + 1,
        workspace: { root: `/w${i + 1}` },
        explorer: { activePath: null, expandedPaths: [], sort },
        ...(i < 3 ? {} : { lastClosedAt: 1000 + i }), // seq 1..3 无时间戳
      })),
    ];
    await saveExplorer(explorerFile, payload);

    await prepareExplorerFileForBoot(explorerFile, legacyLayoutFile, 64, new Set([0]));

    const seqs = (await loadExplorer(explorerFile))!.windows.map((w) => w.windowSeq);
    expect(seqs).toHaveLength(64);
    expect(seqs).toEqual(expect.arrayContaining([0, 1, 2, 3]));
    expect(seqs).not.toContain(4); // 有时间戳的最旧段
    expect(seqs).not.toContain(10);
    expect(seqs).toContain(11);
  });

  it('v2 文件:迁移写 v3 后在同一次加载结果上收敛(不再重读)', async () => {
    await fs.writeFile(explorerFile, JSON.stringify(v2Payload));
    await fs.writeFile(legacyLayoutFile, JSON.stringify({ version: 1, panels: {} }));
    const opens = countExplorerOpens();

    await prepareExplorerFileForBoot(explorerFile, legacyLayoutFile, 64, new Set([0]));

    expect(opens.count()).toBe(1);
    vi.restoreAllMocks();
    const raw = JSON.parse(await fs.readFile(explorerFile, 'utf-8')) as { version: number };
    expect(raw.version).toBe(3);
    expect(existsSync(legacyLayoutFile)).toBe(false);
  });

  it('损坏文件:不覆盖、保留 legacy、写 .corrupt 快照', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fs.writeFile(explorerFile, '{not json');
    await fs.writeFile(legacyLayoutFile, JSON.stringify({ version: 1 }));

    await prepareExplorerFileForBoot(explorerFile, legacyLayoutFile, 64, new Set([0]));

    expect(await fs.readFile(explorerFile, 'utf-8')).toBe('{not json');
    expect(await fs.readFile(`${explorerFile}.corrupt`, 'utf-8')).toBe('{not json');
    expect(existsSync(legacyLayoutFile)).toBe(true);
  });

  it('收敛写盘失败只告警,不抛(与启动时 prune 失败降级一致)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const payload = defaultExplorerV3();
    payload.windows = [
      payload.windows[0]!,
      ...Array.from({ length: 70 }, (_, i) => ({
        windowSeq: i + 1,
        workspace: { root: `/w${i + 1}` },
        explorer: { activePath: null, expandedPaths: [], sort: { by: 'name' as const, reverse: false } },
        lastClosedAt: 1000 + i,
      })),
    ];
    await saveExplorer(explorerFile, payload);
    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }));

    await expect(
      prepareExplorerFileForBoot(explorerFile, legacyLayoutFile, 64, new Set([0])),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[boot] explorer window segment prune skipped', expect.anything());
  });

  it('文件缺失且无 legacy:不读不写', async () => {
    const opens = countExplorerOpens();
    await prepareExplorerFileForBoot(explorerFile, legacyLayoutFile, 64, new Set([0]));
    expect(opens.count()).toBe(0);
    expect(existsSync(explorerFile)).toBe(false);
  });
});
