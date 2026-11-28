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
import { explorerExtFilePath, hashExplorerText, stripEditorGroupPanels } from '../../../electron/main/explorer-downgrade-compat';
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
        popoutWindowModes: [{ id: '3', mode: 'fullscreen', position: { left: 300, top: 120, width: 640, height: 480 } }],
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
  it('旧版本改了某窗口的 tab 列表 → 该窗口以 explorer.json 为准,不合并已对不上的 tab 结构(组 / 固定 / 预览 / MRU);几何、搜索、视图状态、编码、快照照常回来;别的窗口不受影响', async () => {
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
    // 窗口 2 的 tab 没动:预览 tab 照常回来
    expect(loaded.windows[1]!.editor).toEqual(fullPayload().windows[1]!.editor);
    expect(loaded.openWindowSeqs).toEqual([2, 0]);
    expect(loaded.workspaceSnapshots).toEqual(fullPayload().workspaceSnapshots);
  });

  it('旧版本删掉的窗口段:旁挂文件里它的字段不再出现', async () => {
    await writeExplorerFile(file, fullPayload());
    const old = ExplorerSchemaV3_0215.parse(await readJson(file));
    old.windows = old.windows.filter((w) => w.windowSeq === 0);
    await fs.writeFile(file, JSON.stringify(old, null, 2));
    const loaded = (await loadExplorer(file))!;
    expect(loaded.windows.map((w) => w.windowSeq)).toEqual([0]);
    // 上次退出时开着的窗口只留仍在的
    expect(loaded.openWindowSeqs).toEqual([0]);
  });
});

/** dockview 实际写出的两组拆分 layout(左 editor、右 editor:2,活动组 = 右侧)。 */
function splitLayout(): Record<string, unknown> {
  const panel = (id: string, title: string) => ({
    id,
    contentComponent: 'editor',
    tabComponent: 'props.defaultTabComponent',
    params: { titleKey: 'panels.editor.title' },
    title,
  });
  return {
    version: 1,
    grid: {
      root: {
        type: 'branch',
        data: [
          { type: 'leaf', data: { views: ['editor'], activeView: 'editor', id: '1' }, size: 476 },
          { type: 'leaf', data: { views: ['editor:2'], activeView: 'editor:2', id: '2' }, size: 476 },
        ],
        size: 740,
      },
      width: 952,
      height: 740,
      orientation: 'HORIZONTAL',
    },
    panels: { editor: panel('editor', 'Editor'), 'editor:2': panel('editor:2', 'Editor 2') },
    activeGroup: '2',
  };
}

function splitPayload(): ExplorerPayloadV3 {
  const p = fullPayload();
  p.windows[0]!.layout = splitLayout();
  return p;
}

type Grid = { root: { data: { data: { views: string[]; activeView: string; id: string }; size: number }[] }; width: number };

describe('拆分过编辑器组的 layout', () => {
  it('写给 0.2.15 的 layout 只有一个编辑器面板,空出的尺寸给它;仍过 0.2.15 strict schema;新版读回完整 layout', async () => {
    await writeExplorerFile(file, splitPayload());
    const onDisk = await readJson(file);
    const old = ExplorerSchemaV3_0215.safeParse(onDisk);
    expect(old.success, JSON.stringify(old.error?.issues)).toBe(true);
    const layout = old.data!.windows[0]!.layout as { panels: Record<string, unknown>; grid: Grid; activeGroup: string };
    expect(Object.keys(layout.panels)).toEqual(['editor']);
    expect(layout.grid.root.data).toEqual([{ type: 'leaf', data: { views: ['editor'], activeView: 'editor', id: '1' }, size: 952 }]);
    expect(layout.activeGroup).toBe('1');
    expect(await loadExplorer(file)).toEqual(splitPayload());
  });

  it('0.2.15 什么都不动退出(重写面板标题 / 尺寸 / lastClosedAt / 整份格式)→ 再升级,编辑器组、固定 tab、完整 layout 都在', async () => {
    await writeExplorerFile(file, splitPayload());
    const old = ExplorerSchemaV3_0215.parse(await readJson(file));
    const w0 = old.windows[0]!;
    const layout = w0.layout as { panels: Record<string, { title: string }>; grid: Grid & { height: number } };
    layout.panels['editor']!.title = '编辑器';
    layout.grid.width = 1000;
    layout.grid.height = 700;
    layout.grid.root.data[0]!.size = 1000;
    w0.lastClosedAt = 1_800_000_000_000;
    old.windows[1]!.lastClosedAt = 1_800_000_000_001;
    await fs.writeFile(file, JSON.stringify(old));

    const loaded = (await loadExplorer(file))!;
    expect(loaded.windows[0]!.layout).toEqual(splitLayout());
    expect(loaded.windows[0]!.editor).toEqual(splitPayload().windows[0]!.editor);
    expect(loaded.windows[0]!.lastClosedAt).toBe(1_800_000_000_000);
    expect(loaded.windows[1]!.editor).toEqual(splitPayload().windows[1]!.editor);
    expect(loaded.openWindowSeqs).toEqual([2, 0]);
  });

  it('0.2.15 里只切换了活动 tab(切到另一组的文件)→ 编辑器组、固定 tab、MRU、完整 layout 都在;旧版选中的文件成为其所在组的活动 tab,该组成为活动组', async () => {
    await writeExplorerFile(file, splitPayload());
    const old = ExplorerSchemaV3_0215.parse(await readJson(file));
    old.windows[0]!.editor = { openFilePaths: ['/ws/a.ts', '/ws/b.ts', '/ws/c.md'], activePath: '/ws/c.md' };
    await fs.writeFile(file, JSON.stringify(old, null, 2));

    const loaded = (await loadExplorer(file))!;
    expect(loaded.windows[0]!.layout).toEqual(splitLayout());
    const editor = loaded.windows[0]!.editor!;
    expect(editor.activePath).toBe('/ws/c.md');
    expect(editor.groups).toEqual(splitPayload().windows[0]!.editor!.groups);
    expect(editor.activeGroup).toBe('editor:2');
    expect(editor.groupMru).toEqual(['editor:2', 'editor']);
    expect(editor.viewStates).toEqual(fullPayload().windows[0]!.editor!.viewStates);
  });

  it('0.2.15 里只切换了活动 tab(同组另一个文件)→ 该组活动 tab 改为它并移到组内 MRU 首位,固定 tab 保留,活动组不变', async () => {
    await writeExplorerFile(file, splitPayload());
    const old = ExplorerSchemaV3_0215.parse(await readJson(file));
    old.windows[0]!.editor = { openFilePaths: ['/ws/a.ts', '/ws/b.ts', '/ws/c.md'], activePath: '/ws/b.ts' };
    await fs.writeFile(file, JSON.stringify(old, null, 2));

    const loaded = (await loadExplorer(file))!;
    expect(loaded.windows[0]!.layout).toEqual(splitLayout());
    const editor = loaded.windows[0]!.editor!;
    expect(editor.activeGroup).toBe('editor');
    expect(editor.groupMru).toEqual(['editor', 'editor:2']);
    expect(editor.groups![0]).toEqual({
      id: 'editor',
      openFilePaths: ['/ws/a.ts', '/ws/b.ts'],
      activePath: '/ws/b.ts',
      stickyPaths: ['/ws/a.ts'],
      mruPaths: ['/ws/b.ts', '/ws/a.ts'],
    });
    expect(editor.groups![1]).toEqual(splitPayload().windows[0]!.editor!.groups![1]);
  });

  it('0.2.15 里切到原活动组之外的组的文件 → 还原的完整 layout 的活动 dock 组也改指该组(启动时 dock 不把活动组抢回去)', async () => {
    const p = splitPayload();
    p.windows[0]!.editor!.activeGroup = 'editor:2';
    p.windows[0]!.editor!.groupMru = ['editor:2', 'editor'];
    p.windows[0]!.editor!.activePath = '/ws/c.md';
    await writeExplorerFile(file, p);
    const old = ExplorerSchemaV3_0215.parse(await readJson(file));
    old.windows[0]!.editor = { openFilePaths: ['/ws/a.ts', '/ws/b.ts', '/ws/c.md'], activePath: '/ws/a.ts' };
    await fs.writeFile(file, JSON.stringify(old, null, 2));

    const loaded = (await loadExplorer(file))!;
    const editor = loaded.windows[0]!.editor!;
    expect(editor.activeGroup).toBe('editor');
    expect(editor.groupMru).toEqual(['editor', 'editor:2']);
    expect(editor.groups).toEqual(p.windows[0]!.editor!.groups);
    expect(loaded.windows[0]!.layout).toEqual({ ...splitLayout(), activeGroup: '1' });
  });

  it('单组窗口在 0.2.15 里只切换了活动 tab → 固定 / 预览 tab 照常回来,MRU 首位改为旧版选中的文件', async () => {
    const p = fullPayload();
    p.windows[1]!.editor = {
      openFilePaths: ['/ws2/x.ts', '/ws2/y.ts'],
      activePath: '/ws2/x.ts',
      stickyPaths: ['/ws2/x.ts'],
      previewPath: '/ws2/y.ts',
      mruPaths: ['/ws2/x.ts', '/ws2/y.ts'],
    };
    await writeExplorerFile(file, p);
    const old = ExplorerSchemaV3_0215.parse(await readJson(file));
    old.windows[1]!.editor = { openFilePaths: ['/ws2/x.ts', '/ws2/y.ts'], activePath: '/ws2/y.ts' };
    await fs.writeFile(file, JSON.stringify(old, null, 2));

    const loaded = (await loadExplorer(file))!;
    expect(loaded.windows[1]!.editor).toEqual({
      openFilePaths: ['/ws2/x.ts', '/ws2/y.ts'],
      activePath: '/ws2/y.ts',
      stickyPaths: ['/ws2/x.ts'],
      previewPath: '/ws2/y.ts',
      mruPaths: ['/ws2/y.ts', '/ws2/x.ts'],
    });
  });

  it('0.2.15 里重排了 tab(tab 列表顺序变了)→ 仍算改了 tab,以 0.2.15 为准', async () => {
    await writeExplorerFile(file, splitPayload());
    const old = ExplorerSchemaV3_0215.parse(await readJson(file));
    old.windows[0]!.editor = { openFilePaths: ['/ws/b.ts', '/ws/a.ts', '/ws/c.md'], activePath: '/ws/a.ts' };
    await fs.writeFile(file, JSON.stringify(old, null, 2));

    const loaded = (await loadExplorer(file))!;
    expect(loaded.windows[0]!.editor!.groups).toBeUndefined();
    expect(loaded.windows[0]!.editor!.openFilePaths).toEqual(['/ws/b.ts', '/ws/a.ts', '/ws/c.md']);
  });

  it('更早写的旁挂文件(tab 摘要含 activePath)+ 0.2.15 什么都不动 → 编辑器组照常回来', async () => {
    await writeExplorerFile(file, splitPayload());
    const ext = (await readJson(explorerExtFilePath(file))) as { windows: { windowSeq: number; tabs?: string }[] };
    const onDisk = (await readJson(file)) as ExplorerPayloadV3;
    for (const w of ext.windows) {
      const e = onDisk.windows.find((x) => x.windowSeq === w.windowSeq)!.editor!;
      w.tabs = hashExplorerText(JSON.stringify([e.openFilePaths, e.activePath]));
    }
    await fs.writeFile(explorerExtFilePath(file), JSON.stringify(ext));

    const loaded = (await loadExplorer(file))!;
    expect(loaded.windows[0]!.layout).toEqual(splitLayout());
    expect(loaded.windows[0]!.editor).toEqual(splitPayload().windows[0]!.editor);
  });

  it('0.2.15 里改了 tab → 以 0.2.15 的 tab 与 layout 为准(不还原组面板,只剩一个编辑器)', async () => {
    await writeExplorerFile(file, splitPayload());
    const old = ExplorerSchemaV3_0215.parse(await readJson(file));
    old.windows[0]!.editor = { openFilePaths: ['/ws/a.ts', '/ws/e.ts'], activePath: '/ws/e.ts' };
    await fs.writeFile(file, JSON.stringify(old, null, 2));

    const loaded = (await loadExplorer(file))!;
    expect(Object.keys((loaded.windows[0]!.layout as { panels: object }).panels)).toEqual(['editor']);
    expect(loaded.windows[0]!.editor!.groups).toBeUndefined();
    expect(loaded.windows[0]!.editor!.openFilePaths).toEqual(['/ws/a.ts', '/ws/e.ts']);
  });

  it('0.2.15 里挪过面板(layout 结构变了)、tab 没动 → 用 0.2.15 的 layout,编辑器组不合并(组面板已不在 layout 里)', async () => {
    await writeExplorerFile(file, splitPayload());
    const old = ExplorerSchemaV3_0215.parse(await readJson(file));
    const layout = old.windows[0]!.layout as { grid: { orientation: string } };
    layout.grid.orientation = 'VERTICAL';
    await fs.writeFile(file, JSON.stringify(old, null, 2));

    const loaded = (await loadExplorer(file))!;
    expect(loaded.windows[0]!.layout).toEqual(layout);
    expect(loaded.windows[0]!.editor).toEqual({
      openFilePaths: ['/ws/a.ts', '/ws/b.ts', '/ws/c.md'],
      activePath: '/ws/a.ts',
      mode: 'preview',
      viewStates: fullPayload().windows[0]!.editor!.viewStates,
      encodings: fullPayload().windows[0]!.editor!.encodings,
    });
  });
});

describe('stripEditorGroupPanels(写给 0.2.15 的 layout)', () => {
  it('没有组面板 → 原对象', () => {
    const l = { grid: { root: { type: 'leaf', data: { views: ['editor'], activeView: 'editor', id: '1' } } }, panels: { editor: {} } };
    expect(stripEditorGroupPanels(l)).toBe(l);
  });

  it('主编辑器被关掉、只剩组面板 → 第一个组面板顶替 `editor`,其余去掉', () => {
    const l = splitLayout();
    const panels = l['panels'] as Record<string, unknown>;
    panels['editor:3'] = { id: 'editor:3', contentComponent: 'editor' };
    delete panels['editor'];
    const root = (l['grid'] as Grid).root;
    root.data[0]!.data = { views: ['editor:3'], activeView: 'editor:3', id: '1' };
    const out = stripEditorGroupPanels(l) as { panels: Record<string, { id: string }>; grid: Grid; activeGroup: string };
    expect(Object.keys(out.panels)).toEqual(['editor']);
    expect(out.panels['editor']!.id).toBe('editor');
    expect(out.grid.root.data).toEqual([{ type: 'leaf', data: { views: ['editor'], activeView: 'editor', id: '1' }, size: 952 }]);
    expect(out.activeGroup).toBe('1');
  });

  it('组面板与别的面板同组 / 在嵌套分支 / 浮动组里 → 只去掉组面板,别的面板与分支照留,空组去掉', () => {
    const l = {
      grid: {
        root: {
          type: 'branch',
          size: 600,
          data: [
            { type: 'leaf', size: 300, data: { views: ['editor'], activeView: 'editor', id: '1' } },
            {
              type: 'branch',
              size: 300,
              data: [
                { type: 'leaf', size: 200, data: { views: ['editor:2', 'search'], activeView: 'editor:2', id: '2' } },
                { type: 'leaf', size: 400, data: { views: ['editor:3'], activeView: 'editor:3', id: '3' } },
              ],
            },
          ],
        },
        orientation: 'HORIZONTAL',
      },
      floatingGroups: [{ data: { views: ['editor:4'], activeView: 'editor:4', id: '4' }, position: {} }],
      panels: { editor: {}, 'editor:2': {}, 'editor:3': {}, 'editor:4': {}, search: {} },
      activeGroup: '3',
    };
    const out = stripEditorGroupPanels(l) as typeof l;
    expect(Object.keys(out.panels)).toEqual(['editor', 'search']);
    expect(out.grid.root.data[1]).toEqual({
      type: 'branch',
      size: 300,
      data: [{ type: 'leaf', size: 600, data: { views: ['search'], activeView: 'search', id: '2' } }],
    });
    expect(out.floatingGroups).toEqual([]);
    expect(out.activeGroup).toBe('1');
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
