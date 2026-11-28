// BDD: explorer-downgrade-compat —— 新版写的会话文件回退到 0.2.15 仍能读,再升级时新增字段回来。
// 0.2.15 的 v3 schema 是 strict:不认识的字段 = 损坏 → 默认值覆盖(原文只留在一次性 explorer.json.corrupt)。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadExplorer,
  prepareExplorerFileForBoot,
  writeExplorerFile,
} from '../../../electron/main/persistence';
import { explorerExtFilePath } from '../../../electron/main/explorer-downgrade-compat';
import type { ExplorerPayloadV3 } from '../../../electron/shared/explorer-persistence-schema';
import { ExplorerSchemaV3 as ExplorerSchemaV3_0215 } from './fixtures/explorer-schema-0.2.15';

const SORT = { by: 'name', reverse: false } as const;

/** 每个新增字段都填上的会话(新增字段漏拆 → 旧 schema 拒;漏合并 → 往返不等)。 */
function fullPayload(): ExplorerPayloadV3 {
  return {
    version: 3,
    workspace: { recentRoots: ['/ws', '/ws2'] },
    pinned: { paths: ['/ws/pinned.ts'] },
    nextWindowSeq: 3,
    restoreAllWindowsOnLaunch: false,
    openWindowSeqs: [2, 0],
    workspaceSnapshots: [
      {
        workspace: { root: '/ws2' },
        explorer: { activePath: null, expandedPaths: ['/ws2/src'], sort: SORT },
        editor: { openFilePaths: ['/ws2/b.ts'], activePath: '/ws2/b.ts', stickyPaths: ['/ws2/b.ts'] },
        search: { pattern: 'foo' },
        layout: { grid: {} },
      },
    ],
    windows: [
      {
        windowSeq: 0,
        workspace: { root: '/ws' },
        explorer: { activePath: '/ws/a.ts', expandedPaths: ['/ws/src'], sort: SORT },
        layoutUi: { sidebarOpen: true, sidebarWidth: 280 },
        editor: {
          openFilePaths: ['/ws/a.ts', '/ws/b.ts', '/ws/c.md'],
          activePath: '/ws/a.ts',
          mode: 'preview',
          viewStates: [{ path: '/ws/a.ts', selection: { anchor: 3, head: 5 }, topLine: 2 }],
          encodings: [{ path: '/ws/b.ts', encoding: 'gbk' }],
          groups: [
            { id: 'editor', openFilePaths: ['/ws/a.ts', '/ws/b.ts'], activePath: '/ws/a.ts', stickyPaths: ['/ws/a.ts'], mruPaths: ['/ws/a.ts', '/ws/b.ts'] },
            { id: 'editor:2', openFilePaths: ['/ws/c.md'], activePath: '/ws/c.md', previewPath: '/ws/c.md' },
          ],
          activeGroup: 'editor',
          groupMru: ['editor', 'editor:2'],
        },
        search: { pattern: 'needle', isRegex: true, include: 'src/**' },
        layout: { grid: { root: {} }, panels: {} },
        lastClosedAt: null,
        windowState: { bounds: { x: 10, y: 20, width: 1200, height: 800 }, isMaximized: true },
      },
      {
        windowSeq: 2,
        workspace: { root: '/ws2' },
        explorer: { activePath: null, expandedPaths: [], sort: SORT },
        editor: { openFilePaths: ['/ws2/x.ts'], activePath: '/ws2/x.ts', previewPath: '/ws2/x.ts' },
        lastClosedAt: 123,
        windowState: { bounds: { x: -100, y: 0, width: 800, height: 600 } },
      },
    ],
  };
}

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-downgrade-'));
  file = path.join(dir, 'explorer.json');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const readJson = async (p: string): Promise<unknown> => JSON.parse(await fs.readFile(p, 'utf8'));

describe('写出的 explorer.json 能被 0.2.15 读', () => {
  it('所有新增字段都不进 explorer.json(0.2.15 的 strict v3 schema 校验通过),窗口 / 最近目录 / tab 列表原样在', async () => {
    await writeExplorerFile(file, fullPayload());
    const onDisk = await readJson(file);
    const old = ExplorerSchemaV3_0215.safeParse(onDisk);
    expect(old.success, JSON.stringify(old.error?.issues)).toBe(true);
    expect(old.data!.workspace.recentRoots).toEqual(['/ws', '/ws2']);
    expect(old.data!.windows.map((w) => w.windowSeq)).toEqual([0, 2]);
    expect(old.data!.windows[0]!.editor).toEqual({ openFilePaths: ['/ws/a.ts', '/ws/b.ts', '/ws/c.md'], activePath: '/ws/a.ts' });
    expect(old.data!.windows[0]!.layout).toEqual({ grid: { root: {} }, panels: {} });
  });

  it('新版读回时新增字段从旁挂文件合并回来(往返不丢)', async () => {
    await writeExplorerFile(file, fullPayload());
    expect(await loadExplorer(file)).toEqual(fullPayload());
  });

  it('没有新增字段时不留旁挂文件', async () => {
    await writeExplorerFile(file, fullPayload());
    const plain = ExplorerSchemaV3_0215.parse(await readJson(file)) as ExplorerPayloadV3;
    await writeExplorerFile(file, plain);
    await expect(fs.access(explorerExtFilePath(file))).rejects.toThrow();
    expect(await loadExplorer(file)).toEqual(plain);
  });
});

describe('降级期间旧版本改过 explorer.json', () => {
  it('旧版本改了 tab 列表 → 以 explorer.json 为准,不合并已对不上的 tab 结构(组 / 固定 / 预览 / MRU / openWindowSeqs);几何、搜索、视图状态、编码、快照照常回来', async () => {
    await writeExplorerFile(file, fullPayload());
    // 模拟 0.2.15 读-改-写(它按自己的 schema 写回整份,2 空格缩进)
    const old = ExplorerSchemaV3_0215.parse(await readJson(file));
    old.windows[0]!.editor = { openFilePaths: ['/ws/a.ts', '/ws/new.ts'], activePath: '/ws/new.ts' };
    old.workspace.recentRoots = ['/ws3', '/ws', '/ws2'];
    await fs.writeFile(file, JSON.stringify(old, null, 2));

    const loaded = (await loadExplorer(file))!;
    expect(loaded.workspace.recentRoots).toEqual(['/ws3', '/ws', '/ws2']);
    const w0 = loaded.windows[0]!;
    expect(w0.editor).toEqual({
      openFilePaths: ['/ws/a.ts', '/ws/new.ts'],
      activePath: '/ws/new.ts',
      mode: 'preview',
      viewStates: fullPayload().windows[0]!.editor!.viewStates,
      encodings: fullPayload().windows[0]!.editor!.encodings,
    });
    expect(w0.windowState).toEqual(fullPayload().windows[0]!.windowState);
    expect(w0.search).toEqual(fullPayload().windows[0]!.search);
    expect(loaded.windows[1]!.editor).toEqual({ openFilePaths: ['/ws2/x.ts'], activePath: '/ws2/x.ts' });
    expect(loaded.openWindowSeqs).toBeUndefined();
    expect(loaded.workspaceSnapshots).toEqual(fullPayload().workspaceSnapshots);
  });

  it('旧版本删掉的窗口段:旁挂文件里它的字段不再出现', async () => {
    await writeExplorerFile(file, fullPayload());
    const old = ExplorerSchemaV3_0215.parse(await readJson(file));
    old.windows = old.windows.filter((w) => w.windowSeq === 0);
    await fs.writeFile(file, JSON.stringify(old, null, 2));
    const loaded = (await loadExplorer(file))!;
    expect(loaded.windows.map((w) => w.windowSeq)).toEqual([0]);
  });
});

describe('旁挂文件缺失 / 损坏', () => {
  it('缺失 → 只用 explorer.json', async () => {
    await writeExplorerFile(file, fullPayload());
    await fs.rm(explorerExtFilePath(file));
    const loaded = (await loadExplorer(file))!;
    expect(loaded.windows[0]!.editor).toEqual({ openFilePaths: ['/ws/a.ts', '/ws/b.ts', '/ws/c.md'], activePath: '/ws/a.ts' });
    expect(loaded.windows[0]!.windowState).toBeUndefined();
  });

  it('JSON 损坏 → 只用 explorer.json,原文留 .corrupt', async () => {
    await writeExplorerFile(file, fullPayload());
    const ext = explorerExtFilePath(file);
    await fs.writeFile(ext, '{"version":1,');
    const loaded = (await loadExplorer(file))!;
    expect(loaded.workspace.recentRoots).toEqual(['/ws', '/ws2']);
    expect(loaded.openWindowSeqs).toBeUndefined();
    expect(await fs.readFile(`${ext}.corrupt`, 'utf8')).toBe('{"version":1,');
  });

  it('字段值畸形(合并后不合 schema)→ 只用 explorer.json', async () => {
    await writeExplorerFile(file, fullPayload());
    const ext = explorerExtFilePath(file);
    const json = (await readJson(ext)) as { windows: { fields: Record<string, unknown> }[] };
    json.windows[0]!.fields['windowState'] = { bounds: 'bad' };
    await fs.writeFile(ext, JSON.stringify(json));
    const loaded = (await loadExplorer(file))!;
    expect(loaded.windows[0]!.windowState).toBeUndefined();
    expect(loaded.windows[0]!.workspace.root).toBe('/ws');
  });
});

describe('启动时', () => {
  it('未拆分的旧文件(explorer.json 带新增字段)启动时重写成 0.2.15 能读的形态,新增字段不丢', async () => {
    await fs.writeFile(file, JSON.stringify(fullPayload(), null, 2));
    await prepareExplorerFileForBoot(file, path.join(dir, 'layout.json'), new Set());
    expect(ExplorerSchemaV3_0215.safeParse(await readJson(file)).success).toBe(true);
    expect(await loadExplorer(file)).toEqual(fullPayload());
  });

  it('旧版本把新版会话当损坏重建成空会话 → 从 explorer.json.corrupt 自动恢复,.corrupt 改名 .restored', async () => {
    await fs.writeFile(`${file}.corrupt`, JSON.stringify(fullPayload(), null, 2));
    // 0.2.15 重建出的默认会话(主窗、无文件夹)
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 3,
        workspace: { recentRoots: [] },
        pinned: { paths: [] },
        nextWindowSeq: 1,
        windows: [{ windowSeq: 0, workspace: { root: null }, explorer: { activePath: null, expandedPaths: [], sort: SORT }, editor: { openFilePaths: [], activePath: null }, layout: {} }],
      }),
    );
    await prepareExplorerFileForBoot(file, path.join(dir, 'layout.json'), new Set());
    expect(await loadExplorer(file)).toEqual(fullPayload());
    await expect(fs.access(`${file}.corrupt`)).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(`${file}.corrupt.restored`, 'utf8'))).toEqual(fullPayload());
  });

  it('降级期间已有新会话数据 → 不覆盖,.corrupt 原样保留', async () => {
    await fs.writeFile(`${file}.corrupt`, JSON.stringify(fullPayload()));
    const current = {
      version: 3,
      workspace: { recentRoots: ['/other'] },
      pinned: { paths: [] },
      nextWindowSeq: 1,
      windows: [{ windowSeq: 0, workspace: { root: '/other' }, explorer: { activePath: null, expandedPaths: [], sort: SORT } }],
    };
    await fs.writeFile(file, JSON.stringify(current));
    await prepareExplorerFileForBoot(file, path.join(dir, 'layout.json'), new Set());
    expect((await loadExplorer(file))!.workspace.recentRoots).toEqual(['/other']);
    expect(JSON.parse(await fs.readFile(`${file}.corrupt`, 'utf8'))).toEqual(fullPayload());
  });

  it('.corrupt 是真损坏(本版本也解析不了)→ 不恢复', async () => {
    await fs.writeFile(`${file}.corrupt`, '{"version":3,"windows":');
    await prepareExplorerFileForBoot(file, path.join(dir, 'layout.json'), new Set());
    expect(await loadExplorer(file)).toBeNull();
    expect(await fs.readFile(`${file}.corrupt`, 'utf8')).toBe('{"version":3,"windows":');
  });
});
