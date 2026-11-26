// 「最近打开」多窗口不互相覆盖:main 侧增量置顶 + 写后广播。见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  defaultExplorerV3,
  loadExplorer,
  promoteRecentRoot,
  removeRecentRoot,
  type ExplorerPayloadV3,
} from '../../../electron/main/persistence';
import { registerIpc } from '../../../electron/main/ipc';
import {
  _reset as resetWindowSeq,
  setWindowSeq,
} from '../../../electron/main/services/window-seq.service';
import { EXPLORER_CHANNELS } from '../../../electron/shared/persistence-channels';

type MockWin = { id: number; isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } };

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  userData: '',
  senderToWindow: new Map<object, unknown>(),
  windows: [] as unknown[],
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => h.userData) },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => {
      h.handlers.set(channel, fn);
    }),
  },
  BrowserWindow: {
    fromWebContents: vi.fn((sender: object) => h.senderToWindow.get(sender) ?? null),
    getAllWindows: () => h.windows,
  },
}));

vi.mock('../../../electron/main/ipc/fs.ipc', () => ({ registerFsIpc: vi.fn() }));
vi.mock('../../../electron/main/ipc/terminal.ipc', () => ({ registerTerminalIpc: vi.fn() }));
vi.mock('../../../electron/main/ipc/plugins.ipc', () => ({ registerPluginsIpc: vi.fn() }));
vi.mock('../../../electron/main/ipc/shell.ipc', () => ({ registerShellIpc: vi.fn() }));
vi.mock('../../../electron/main/ipc/window.ipc', () => ({ registerWindowIpc: vi.fn() }));
vi.mock('../../../electron/main/services/agent-auth.service', () => ({
  answerAgentAuthRequest: vi.fn(),
  revokeAndKillAgentSessions: vi.fn(),
}));
vi.mock('../../../electron/main/services/mcp-stdio-config.service', () => ({
  getStdioConfig: vi.fn(),
}));

const sort = { by: 'name' as const, reverse: false };
const senderA = {};
const senderB = {};
let winA: MockWin;
let winB: MockWin;
let dir: string;
let explorerFile: string;

function fakeWin(id: number): MockWin {
  return { id, isDestroyed: () => false, webContents: { send: vi.fn() } };
}

async function invoke(channel: string, raw: unknown, sender: object): Promise<unknown> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`missing handler ${channel}`);
  return fn({ sender, senderFrame: { url: 'file:///renderer/index.html' } }, raw);
}

function diskWith(recentRoots: string[]): ExplorerPayloadV3 {
  const p = defaultExplorerV3();
  p.workspace.recentRoots = recentRoots;
  p.nextWindowSeq = 2;
  p.windows = [
    { windowSeq: 0, workspace: { root: '/a' }, explorer: { activePath: null, expandedPaths: [], sort } },
    { windowSeq: 1, workspace: { root: '/b' }, explorer: { activePath: null, expandedPaths: [], sort } },
  ];
  return p;
}

function writableFor(seq: number, recentRoots: string[], expanded: string[] = []) {
  return {
    version: 3,
    workspace: { recentRoots },
    pinned: { paths: [] },
    nextWindowSeq: 2,
    windows: [
      { windowSeq: seq, workspace: { root: seq === 0 ? '/a' : '/b' }, explorer: { activePath: null, expandedPaths: expanded, sort } },
    ],
  };
}

function recentSends(win: MockWin): unknown[] {
  return win.webContents.send.mock.calls
    .filter((c) => c[0] === EXPLORER_CHANNELS.RECENT_CHANGED)
    .map((c) => c[1]);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'continuo-recent-'));
  explorerFile = path.join(dir, 'explorer.json');
  h.userData = dir;
  h.handlers.clear();
  h.senderToWindow.clear();
  winA = fakeWin(101);
  winB = fakeWin(202);
  h.senderToWindow.set(senderA, winA);
  h.senderToWindow.set(senderB, winB);
  h.windows.length = 0;
  h.windows.push(winA, winB);
  resetWindowSeq();
  setWindowSeq(101, 0);
  setWindowSeq(202, 1);
  registerIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn(), rebuildAppMenu: vi.fn() });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('promoteRecentRoot', () => {
  it('win32:大小写不同的同一目录去重(与 renderer pathEquals 同口径);其它平台按字节区分', () => {
    expect(promoteRecentRoot(['C:\\Code\\Proj', 'D:\\x'], 'c:\\code\\proj', 'win32')).toEqual(['c:\\code\\proj', 'D:\\x']);
    expect(promoteRecentRoot(['/a/B'], '/a/b', 'darwin')).toEqual(['/a/b', '/a/B']);
  });

  it('升级前盘上带尾分隔符的旧条目与规范形视为同一项;根本身不被削掉', () => {
    expect(promoteRecentRoot(['/u/proj/', '/x'], '/u/proj', 'darwin')).toEqual(['/u/proj', '/x']);
    expect(promoteRecentRoot(['C:\\Proj\\'], 'c:\\proj', 'win32')).toEqual(['c:\\proj']);
    expect(promoteRecentRoot(['/'], '/a', 'darwin')).toEqual(['/a', '/']);
    expect(promoteRecentRoot(['C:\\'], 'C:\\x', 'win32')).toEqual(['C:\\x', 'C:\\']);
  });

  it('置顶、去重、保持其余顺序', () => {
    expect(promoteRecentRoot(['/a', '/b', '/c'], '/c')).toEqual(['/c', '/a', '/b']);
    expect(promoteRecentRoot(['/a', '/b'], '/x')).toEqual(['/x', '/a', '/b']);
  });

  it('截断到上限 5', () => {
    expect(promoteRecentRoot(['/1', '/2', '/3', '/4', '/5'], '/x')).toEqual(['/x', '/1', '/2', '/3', '/4']);
  });
});

describe('explorer:touch-recent · 多窗口', () => {
  it('A 打开 /x 后 B 用陈旧列表落盘 → 盘上仍有 /x', async () => {
    await fs.writeFile(explorerFile, JSON.stringify(diskWith(['/old'])), 'utf-8');

    await invoke(EXPLORER_CHANNELS.TOUCH_RECENT, { path: '/x' }, senderA);
    // B 仍持有启动时的 ['/old'],因展开目录落盘
    await invoke(EXPLORER_CHANNELS.WRITE, writableFor(1, ['/old'], ['/b/src']), senderB);

    const saved = await loadExplorer(explorerFile);
    expect(saved?.workspace.recentRoots).toEqual(['/x', '/old']);
    expect(saved?.windows.find((w) => w.windowSeq === 1)?.explorer.expandedPaths).toEqual(['/b/src']);
  });

  it('两窗交替打开 → 盘上含双方新增项,最近在前,列表满时不挤掉对方新增', async () => {
    await fs.writeFile(explorerFile, JSON.stringify(diskWith(['/1', '/2', '/3', '/4', '/5'])), 'utf-8');

    await invoke(EXPLORER_CHANNELS.TOUCH_RECENT, { path: '/x' }, senderA);
    await invoke(EXPLORER_CHANNELS.WRITE, writableFor(1, ['/1', '/2', '/3', '/4', '/5']), senderB);
    await invoke(EXPLORER_CHANNELS.TOUCH_RECENT, { path: '/y' }, senderB);
    await invoke(EXPLORER_CHANNELS.WRITE, writableFor(0, ['/x', '/1', '/2', '/3', '/4']), senderA);

    const saved = await loadExplorer(explorerFile);
    expect(saved?.workspace.recentRoots).toEqual(['/y', '/x', '/1', '/2', '/3']);
  });

  it('touch 成功后向所有窗口(含发起者)广播新列表', async () => {
    await fs.writeFile(explorerFile, JSON.stringify(diskWith(['/old'])), 'utf-8');

    const r = await invoke(EXPLORER_CHANNELS.TOUCH_RECENT, { path: '/x' }, senderA);

    expect(r).toEqual({ ok: true, data: undefined });
    expect(recentSends(winA)).toEqual([{ recentRoots: ['/x', '/old'] }]);
    expect(recentSends(winB)).toEqual([{ recentRoots: ['/x', '/old'] }]);
  });

  it('盘上无 explorer.json(首启)→ 不写不广播;随后的 explorer:write 带上首份列表', async () => {
    await invoke(EXPLORER_CHANNELS.TOUCH_RECENT, { path: '/x' }, senderA);
    expect(await loadExplorer(explorerFile)).toBeNull();
    expect(recentSends(winA)).toEqual([]);

    await invoke(EXPLORER_CHANNELS.WRITE, writableFor(0, ['/x']), senderA);
    expect((await loadExplorer(explorerFile))?.workspace.recentRoots).toEqual(['/x']);
  });

  it('非法路径(空白 / 超长)→ 拒绝,不写盘', async () => {
    await fs.writeFile(explorerFile, JSON.stringify(diskWith(['/old'])), 'utf-8');
    const blank = (await invoke(EXPLORER_CHANNELS.TOUCH_RECENT, { path: '  ' }, senderA)) as { ok: boolean };
    const long = (await invoke(EXPLORER_CHANNELS.TOUCH_RECENT, { path: '/' + 'a'.repeat(9000) }, senderA)) as { ok: boolean };
    expect(blank.ok).toBe(false);
    expect(long.ok).toBe(false);
    expect((await loadExplorer(explorerFile))?.workspace.recentRoots).toEqual(['/old']);
  });
});

describe('removeRecentRoot', () => {
  it('移除同一项(去尾分隔符;win32 大小写不敏感),其余顺序不变;不在列表 → 原样', () => {
    expect(removeRecentRoot(['/a', '/b', '/c'], '/b')).toEqual(['/a', '/c']);
    expect(removeRecentRoot(['/u/proj/', '/x'], '/u/proj', 'darwin')).toEqual(['/x']);
    expect(removeRecentRoot(['C:\\Proj', 'D:\\x'], 'c:\\proj', 'win32')).toEqual(['D:\\x']);
    expect(removeRecentRoot(['/a/B'], '/a/b', 'darwin')).toEqual(['/a/B']);
    expect(removeRecentRoot(['/a'], '/zzz')).toEqual(['/a']);
  });
});

describe('explorer:remove-recent · 多窗口', () => {
  it('锁内重读盘移除该项 → 写盘并向所有窗口广播;别窗刚新增的项不受影响', async () => {
    await fs.writeFile(explorerFile, JSON.stringify(diskWith(['/old', '/gone'])), 'utf-8');
    await invoke(EXPLORER_CHANNELS.TOUCH_RECENT, { path: '/x' }, senderB);

    const r = await invoke(EXPLORER_CHANNELS.REMOVE_RECENT, { path: '/gone' }, senderA);

    expect(r).toEqual({ ok: true, data: undefined });
    expect((await loadExplorer(explorerFile))?.workspace.recentRoots).toEqual(['/x', '/old']);
    expect(recentSends(winA).at(-1)).toEqual({ recentRoots: ['/x', '/old'] });
    expect(recentSends(winB).at(-1)).toEqual({ recentRoots: ['/x', '/old'] });
  });

  it('陈旧窗口随后整表落盘不会把已移除项写回', async () => {
    await fs.writeFile(explorerFile, JSON.stringify(diskWith(['/old', '/gone'])), 'utf-8');
    await invoke(EXPLORER_CHANNELS.REMOVE_RECENT, { path: '/gone' }, senderA);
    await invoke(EXPLORER_CHANNELS.WRITE, writableFor(1, ['/old', '/gone']), senderB);
    expect((await loadExplorer(explorerFile))?.workspace.recentRoots).toEqual(['/old']);
  });

  it('盘上无 explorer.json → 不写不广播;非法路径 → 拒绝', async () => {
    await invoke(EXPLORER_CHANNELS.REMOVE_RECENT, { path: '/x' }, senderA);
    expect(await loadExplorer(explorerFile)).toBeNull();
    expect(recentSends(winA)).toEqual([]);
    const blank = (await invoke(EXPLORER_CHANNELS.REMOVE_RECENT, { path: ' ' }, senderA)) as { ok: boolean };
    expect(blank.ok).toBe(false);
  });
});
