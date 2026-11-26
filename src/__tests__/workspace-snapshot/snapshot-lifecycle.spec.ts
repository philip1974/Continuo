// BDD: workspace-snapshot / main 侧的写入与使用时机:
// - 新窗口(在新窗口打开文件夹 / open-file / 命令行 …)按快照建段并以非 fresh 打开;无快照照旧 fresh;去重命中什么都不做;
// - 同一窗口切换 root(explorer:switch-workspace):存旧 root(dock 布局取盘上本窗段)、返回新 root 的快照;
// - explorer:read 剥离快照表。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadExplorer, type ExplorerPayloadV3 } from '../../../electron/main/persistence';
import { registerIpc } from '../../../electron/main/ipc';
import { openWorkspaceWindowWith, workspaceWindowOpts } from '../../../electron/main/ipc/window.ipc';
import { seedWindowFromWorkspaceSnapshot } from '../../../electron/main/services/workspace-snapshot.service';
import { _reset as resetWindowSeq, setWindowSeq } from '../../../electron/main/services/window-seq.service';
import { _reset as resetRoots, setWorkspaceRoot } from '../../../electron/main/services/window-workspace-roots.service';
import type { WorkspaceSnapshot } from '../../../electron/shared/explorer-persistence-schema';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  userData: '',
  senderToWindow: new Map<object, { id: number }>(),
  windows: new Map<number, unknown>(),
  sent: [] as { channel: string; payload: unknown }[],
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => h.userData), on: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, raw: unknown) => Promise<unknown>) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    fromWebContents: vi.fn((sender: object) => h.senderToWindow.get(sender) ?? null),
    fromId: vi.fn((id: number) => h.windows.get(id) ?? null),
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: { send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }) },
      },
    ]),
  },
}));

vi.mock('../../../electron/main/ipc/fs.ipc', () => ({ registerFsIpc: vi.fn() }));
vi.mock('../../../electron/main/ipc/terminal.ipc', () => ({ registerTerminalIpc: vi.fn() }));
vi.mock('../../../electron/main/ipc/plugins.ipc', () => ({ registerPluginsIpc: vi.fn() }));
vi.mock('../../../electron/main/ipc/shell.ipc', () => ({ registerShellIpc: vi.fn() }));
vi.mock('../../../electron/main/ipc/window.ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/main/ipc/window.ipc')>()),
  registerWindowIpc: vi.fn(),
}));
vi.mock('../../../electron/main/services/agent-auth.service', () => ({
  answerAgentAuthRequest: vi.fn(),
  revokeAndKillAgentSessions: vi.fn(),
}));
vi.mock('../../../electron/main/services/mcp-stdio-config.service', () => ({ getStdioConfig: vi.fn() }));

const SORT = { by: 'name', reverse: false } as const;
const sender = {};
let explorerFile: string;

function ws2Snapshot(): WorkspaceSnapshot {
  return {
    workspace: { root: '/ws2' },
    explorer: { activePath: null, expandedPaths: ['/ws2/src'], sort: SORT },
    layoutUi: { sidebarOpen: false, sidebarWidth: 300 },
    editor: { openFilePaths: ['/ws2/w1.ts'], activePath: '/ws2/w1.ts' },
    search: { pattern: 'todo' },
    layout: { version: 1, grid: { root: 'ws2-layout' } },
  };
}

function payload(over: Partial<ExplorerPayloadV3> = {}): ExplorerPayloadV3 {
  return { version: 3, workspace: { recentRoots: ['/old'] }, pinned: { paths: [] }, nextWindowSeq: 5, windows: [], ...over };
}

async function writeExplorer(p: ExplorerPayloadV3): Promise<void> {
  await fs.writeFile(explorerFile, JSON.stringify(p), 'utf-8');
}

async function invoke(channel: string, raw: unknown): Promise<unknown> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`missing handler ${channel}`);
  return await handler({ sender, senderFrame: { url: 'file:///renderer/index.html' } }, raw);
}

beforeEach(async () => {
  h.userData = await fs.mkdtemp(path.join(tmpdir(), 'continuo-ws-snapshot-'));
  explorerFile = path.join(h.userData, 'explorer.json');
  h.handlers.clear();
  h.senderToWindow.clear();
  h.windows.clear();
  h.sent.length = 0;
  h.senderToWindow.set(sender, { id: 101 });
  resetWindowSeq();
  resetRoots();
  setWindowSeq(101, 2);
  registerIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn() });
});

afterEach(async () => {
  await fs.rm(h.userData, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('新窗口打开文件夹(openWorkspaceWindowWith)', () => {
  it('快照表有这个 root → 按快照建该 seq 的段(含 dock 布局),非 fresh 打开,并置顶「最近打开」', async () => {
    await writeExplorer(payload({ workspaceSnapshots: [ws2Snapshot()] }));
    const create = vi.fn(() => ({ id: 9 }));

    await openWorkspaceWindowWith(create, '/ws2');

    expect(create).toHaveBeenCalledWith({ windowSeq: 5, workspace: '/ws2' });
    const disk = await loadExplorer(explorerFile);
    const { workspace: _w, ...state } = ws2Snapshot();
    expect(disk?.windows.find((w) => w.windowSeq === 5)).toEqual({ windowSeq: 5, workspace: { root: '/ws2' }, ...state });
    expect(disk?.workspace.recentRoots).toEqual(['/ws2', '/old']);
    expect(h.sent).toContainEqual({ channel: 'explorer:recent-changed', payload: { recentRoots: ['/ws2', '/old'] } });
  });

  it('没有这个 root 的快照 → 照旧 fresh,不建段', async () => {
    await writeExplorer(payload({ workspaceSnapshots: [ws2Snapshot()] }));
    const create = vi.fn(() => ({ id: 9 }));

    await openWorkspaceWindowWith(create, '/ws3');

    expect(create).toHaveBeenCalledWith({ windowSeq: 5, workspace: '/ws3', fresh: true });
    expect((await loadExplorer(explorerFile))?.windows).toEqual([]);
  });

  it('该文件夹已在某个窗口打开 → 聚焦它,什么都不做(不分配 seq、不读写快照)', async () => {
    await writeExplorer(payload({ workspaceSnapshots: [ws2Snapshot()] }));
    const before = await fs.readFile(explorerFile, 'utf-8');
    const focus = vi.fn();
    h.windows.set(7, { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, focus });
    setWorkspaceRoot(7, '/ws2');
    const create = vi.fn(() => ({ id: 9 }));

    await openWorkspaceWindowWith(create, '/ws2');

    expect(focus).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await fs.readFile(explorerFile, 'utf-8')).toBe(before);
  });

  it('explorer.json 损坏 → 当空处理:照旧 fresh', async () => {
    await fs.writeFile(explorerFile, '{not json', 'utf-8');
    expect(await workspaceWindowOpts(5, '/ws2')).toEqual({ windowSeq: 5, workspace: '/ws2', fresh: true });
  });

  it('不带文件夹的新窗口 → 空白窗口(不读快照)', async () => {
    expect(await workspaceWindowOpts(5)).toEqual({ windowSeq: 5 });
  });

  it('复用已有段(冷启动 dock 模式的 seq 0)→ 原段先存为它自己 root 的快照,再按目标快照覆盖', async () => {
    await writeExplorer(
      payload({
        workspaceSnapshots: [ws2Snapshot()],
        windows: [
          {
            windowSeq: 0,
            workspace: { root: '/ws1' },
            explorer: { activePath: null, expandedPaths: [], sort: SORT },
            editor: { openFilePaths: ['/ws1/x.ts'], activePath: '/ws1/x.ts' },
            windowState: { bounds: { x: 1, y: 2, width: 800, height: 600 } },
          },
        ],
      }),
    );

    expect(await seedWindowFromWorkspaceSnapshot(explorerFile, 0, '/ws2')).not.toBeNull();

    const disk = await loadExplorer(explorerFile);
    expect(disk?.workspaceSnapshots?.map((s) => s.workspace.root)).toEqual(['/ws1', '/ws2']);
    expect(disk?.workspaceSnapshots?.[0]?.editor?.openFilePaths).toEqual(['/ws1/x.ts']);
    const seg0 = disk?.windows.find((w) => w.windowSeq === 0);
    expect(seg0?.workspace.root).toBe('/ws2');
    expect(seg0?.editor?.openFilePaths).toEqual(['/ws2/w1.ts']);
    // 窗口几何属于窗口,不随快照替换
    expect(seg0?.windowState).toEqual({ bounds: { x: 1, y: 2, width: 800, height: 600 } });
  });
});

describe('同一窗口切换 root(explorer:switch-workspace)', () => {
  const saveWs3 = {
    workspace: { root: '/ws3' },
    explorer: { activePath: null, expandedPaths: ['/ws3/lib'], sort: SORT },
    layoutUi: { sidebarOpen: true, sidebarWidth: 280 },
    editor: { openFilePaths: ['/ws3/b.ts'], activePath: '/ws3/b.ts' },
  };

  it('存旧 root 的快照(dock 布局取盘上本窗段),返回新 root 的快照(不含布局)', async () => {
    await writeExplorer(
      payload({
        workspaceSnapshots: [ws2Snapshot()],
        windows: [
          {
            windowSeq: 2,
            workspace: { root: '/ws3' },
            explorer: { activePath: null, expandedPaths: [], sort: SORT },
            layout: { version: 1, grid: { root: 'win2-layout' } },
          },
        ],
      }),
    );

    const r = (await invoke('explorer:switch-workspace', { save: saveWs3, open: '/ws2' })) as {
      ok: boolean;
      data: unknown;
    };

    const { layout: _l, ...ws2NoLayout } = ws2Snapshot();
    expect(r).toEqual({ ok: true, data: ws2NoLayout });
    const disk = await loadExplorer(explorerFile);
    expect(disk?.workspaceSnapshots?.[0]).toEqual({ ...saveWs3, layout: { version: 1, grid: { root: 'win2-layout' } } });
    expect(disk?.workspaceSnapshots?.map((s) => s.workspace.root)).toEqual(['/ws3', '/ws2']);
  });

  it('新 root 没有快照 → 返回 null(保持原有空白行为)', async () => {
    await writeExplorer(payload());
    const r = (await invoke('explorer:switch-workspace', { save: saveWs3, open: '/ws9' })) as { data: unknown };
    expect(r.data).toBeNull();
    expect((await loadExplorer(explorerFile))?.workspaceSnapshots?.map((s) => s.workspace.root)).toEqual(['/ws3']);
  });

  it('explorer.json 还不存在 → 不建文件(否则之后的整份写回会丢掉本窗的「最近打开」),返回 null', async () => {
    const r = (await invoke('explorer:switch-workspace', { save: saveWs3, open: '/ws2' })) as { data: unknown };
    expect(r.data).toBeNull();
    await expect(fs.access(explorerFile)).rejects.toThrow();
  });

  it('explorer:read 返回前剥离快照表', async () => {
    await writeExplorer(payload({ workspaceSnapshots: [ws2Snapshot()] }));
    const r = (await invoke('explorer:read', undefined)) as { ok: boolean; data: ExplorerPayloadV3 };
    expect(r.ok).toBe(true);
    expect(r.data.workspaceSnapshots).toBeUndefined();
    expect(r.data.workspace.recentRoots).toEqual(['/old']);
  });
});
