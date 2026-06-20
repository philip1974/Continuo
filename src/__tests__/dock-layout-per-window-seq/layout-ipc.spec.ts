import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  hydrateStores,
  snapshotFromStores,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';
import { useExplorerStore } from '../../stores/explorer.store';
import {
  SIDEBAR_DEFAULT_WIDTH,
  useLayoutUiStore,
} from '../../stores/layout-ui.store';
import { usePinnedStore } from '../../stores/pinned.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import {
  defaultExplorerV3,
  loadExplorer,
  type ExplorerPayloadV3,
} from '../../../electron/main/persistence';
import { registerIpc } from '../../../electron/main/ipc';
import {
  _reset as resetWindowSeq,
  setWindowSeq,
} from '../../../electron/main/services/window-seq.service';

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  userData: '',
  senderToWindow: new Map<object, { id: number }>(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronMock.userData),
  },
  ipcMain: {
    handle: vi.fn(
      (
        channel: string,
        handler: (event: unknown, raw: unknown) => Promise<unknown>,
      ) => {
        electronMock.handlers.set(channel, handler);
      },
    ),
  },
  BrowserWindow: {
    fromWebContents: vi.fn((sender: object) => {
      return electronMock.senderToWindow.get(sender) ?? null;
    }),
  },
}));

vi.mock('../../../electron/main/ipc/fs.ipc', () => ({ registerFsIpc: vi.fn() }));
vi.mock('../../../electron/main/ipc/terminal.ipc', () => ({
  registerTerminalIpc: vi.fn(),
}));
vi.mock('../../../electron/main/ipc/plugins.ipc', () => ({
  registerPluginsIpc: vi.fn(),
}));
vi.mock('../../../electron/main/ipc/shell.ipc', () => ({
  registerShellIpc: vi.fn(),
}));
vi.mock('../../../electron/main/ipc/window.ipc', () => ({
  registerWindowIpc: vi.fn(),
}));
vi.mock('../../../electron/main/services/agent-auth.service', () => ({
  resolveAgentAuthRequest: vi.fn(),
  revokeAndKillAgentSessions: vi.fn(),
}));
vi.mock('../../../electron/main/services/mcp-stdio-config.service', () => ({
  getStdioConfig: vi.fn(),
}));

let dir: string;
let explorerFile: string;

const senderA = {};
const senderB = {};

const sort = { by: 'name' as const, reverse: false };

const eventFor = (sender: object) => ({
  sender,
  senderFrame: { url: 'file:///renderer/index.html' },
});

async function invokeIpc(
  channel: string,
  raw: unknown,
  sender: object = senderA,
) {
  const handler = electronMock.handlers.get(channel);
  if (!handler) throw new Error(`missing handler ${channel}`);
  return await handler(eventFor(sender), raw);
}

async function writeExplorer(payload: ExplorerPayloadV3): Promise<void> {
  await fs.writeFile(explorerFile, JSON.stringify(payload, null, 2), 'utf-8');
}

beforeEach(() => {
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useExplorerStore.setState({
    activePath: null,
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
    search: '',
  });
  usePinnedStore.setState({ paths: [] });
  useLayoutUiStore.setState({
    sidebarOpen: true,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  });
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'continuo-layout-ipc-'));
  explorerFile = path.join(dir, 'explorer.json');
  electronMock.userData = dir;
  electronMock.handlers.clear();
  electronMock.senderToWindow.clear();
  electronMock.senderToWindow.set(senderA, { id: 101 });
  electronMock.senderToWindow.set(senderB, { id: 202 });
  resetWindowSeq();
  registerIpc();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const fullSnapshotWithMainOwned: ExplorerSnapshot = {
  version: 3,
  workspace: { recentRoots: ['/work'] },
  pinned: { paths: ['/work/pinned.md'] },
  nextWindowSeq: 1,
  windows: [
    {
      windowSeq: 0,
      workspace: { root: '/work' },
      explorer: {
        activePath: '/work/a.md',
        expandedPaths: ['/work'],
        sort: { by: 'name', reverse: false },
      },
      layoutUi: { sidebarOpen: false, sidebarWidth: 320 },
      layout: { version: 1, dock: { panels: [] } },
      lastClosedAt: 123,
    },
  ],
};

describe('window-scoped layout IPC', () => {
  it('T12: renderer writes v3 writable snapshot without main-owned fields and hydrates full v3', () => {
    expect(() => hydrateStores(fullSnapshotWithMainOwned)).not.toThrow();
    expect(useWorkspaceStore.getState().root).toBe('/work');
    expect(useExplorerStore.getState().activePath).toBe('/work/a.md');

    useWorkspaceStore.setState({ root: '/renderer', recentRoots: ['/renderer'] });
    useExplorerStore.setState({
      activePath: '/renderer/b.md',
      expandedPaths: new Set(['/renderer']),
      sort: { by: 'mtime', reverse: true },
    });
    const writable = snapshotFromStores(fullSnapshotWithMainOwned);
    const w0 = writable.windows[0]! as unknown as Record<string, unknown>;

    expect(writable.version).toBe(3);
    expect(w0).not.toHaveProperty('layout');
    expect(w0).not.toHaveProperty('lastClosedAt');
    expect(writable.windows[0]!.workspace.root).toBe('/renderer');
    expect(writable.windows[0]!.explorer.activePath).toBe('/renderer/b.md');
  });

  it('T9: layout:read resolves sender windowSeq and returns that window layout', async () => {
    setWindowSeq(101, 7);
    const payload = defaultExplorerV3();
    payload.windows = [
      {
        windowSeq: 7,
        workspace: { root: '/a' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: { version: 1, panel: 'A' },
      },
      {
        windowSeq: 8,
        workspace: { root: '/b' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: { version: 1, panel: 'B' },
      },
    ];
    await writeExplorer(payload);

    const result = await invokeIpc('layout:read', undefined);

    expect(result).toEqual({ ok: true, data: { version: 1, panel: 'A' } });
  });

  it('T9b: layout:read without BrowserWindow returns NO_WINDOW', async () => {
    const unknownSender = {};

    const result = await invokeIpc('layout:read', undefined, unknownSender);

    expect(result).toEqual({
      ok: false,
      code: 'NO_WINDOW',
      message: 'no window',
    });
  });

  it('T9c: layout:read without windowSeq returns NO_WINDOW_SEQ', async () => {
    const result = await invokeIpc('layout:read', undefined);

    expect(result).toEqual({
      ok: false,
      code: 'NO_WINDOW_SEQ',
      message: 'no window seq',
    });
  });

  it('T10: layout:write updates only the sender window layout', async () => {
    setWindowSeq(101, 7);
    const payload = defaultExplorerV3();
    payload.windows = [
      {
        windowSeq: 7,
        workspace: { root: '/a' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: { version: 1, panel: 'old-A' },
      },
      {
        windowSeq: 8,
        workspace: { root: '/b' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: { version: 1, panel: 'keep-B' },
      },
    ];
    await writeExplorer(payload);

    const result = await invokeIpc('layout:write', { version: 1, panel: 'new-A' });
    const saved = await loadExplorer(explorerFile);

    expect(result).toEqual({ ok: true, data: undefined });
    expect(saved?.windows.find((w) => w.windowSeq === 7)?.layout).toEqual({
      version: 1,
      panel: 'new-A',
    });
    expect(saved?.windows.find((w) => w.windowSeq === 8)?.layout).toEqual({
      version: 1,
      panel: 'keep-B',
    });
  });

  it('T10b: layout:write creates a missing window entry', async () => {
    setWindowSeq(101, 9);
    await writeExplorer(defaultExplorerV3());

    const result = await invokeIpc('layout:write', {
      version: 1,
      panel: 'created',
    });
    const saved = await loadExplorer(explorerFile);

    expect(result).toEqual({ ok: true, data: undefined });
    expect(saved?.windows.find((w) => w.windowSeq === 9)).toMatchObject({
      windowSeq: 9,
      workspace: { root: null },
      layout: { version: 1, panel: 'created' },
    });
  });

  it('T13: multi-window layout writes do not affect another window entry', async () => {
    setWindowSeq(101, 1);
    setWindowSeq(202, 2);
    await writeExplorer(defaultExplorerV3());

    await invokeIpc('layout:write', { version: 1, panel: 'A' }, senderA);
    await invokeIpc('layout:write', { version: 1, panel: 'B' }, senderB);
    const saved = await loadExplorer(explorerFile);

    expect(saved?.windows.find((w) => w.windowSeq === 1)?.layout).toEqual({
      version: 1,
      panel: 'A',
    });
    expect(saved?.windows.find((w) => w.windowSeq === 2)?.layout).toEqual({
      version: 1,
      panel: 'B',
    });
  });

  it('T16: explorer:write preserves main-owned layout and lastClosedAt fields', async () => {
    // R11:explorer:write 现按 sender 真实 seq 过滤;sender 101 的窗口段 = seq 0。
    setWindowSeq(101, 0);
    const current = defaultExplorerV3();
    current.windows = [
      {
        windowSeq: 0,
        workspace: { root: '/old-a' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: { version: 1, panel: 'A' },
        lastClosedAt: 111,
      },
      {
        windowSeq: 2,
        workspace: { root: '/old-b' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: { version: 1, panel: 'B' },
        lastClosedAt: 222,
      },
    ];
    await writeExplorer(current);

    const result = await invokeIpc('explorer:write', {
      version: 3,
      workspace: { recentRoots: ['/new'] },
      pinned: { paths: ['/new/pinned.md'] },
      nextWindowSeq: 3,
      windows: [
        {
          windowSeq: 0,
          workspace: { root: '/new-a' },
          explorer: { activePath: '/new-a/a.md', expandedPaths: ['/new-a'], sort },
        },
      ],
    });
    const saved = await loadExplorer(explorerFile);

    expect(result).toEqual({ ok: true, data: undefined });
    expect(saved?.windows.find((w) => w.windowSeq === 0)).toMatchObject({
      workspace: { root: '/new-a' },
      layout: { version: 1, panel: 'A' },
      lastClosedAt: 111,
    });
    expect(saved?.windows.find((w) => w.windowSeq === 2)).toMatchObject({
      workspace: { root: '/old-b' },
      layout: { version: 1, panel: 'B' },
      lastClosedAt: 222,
    });
  });

  // codex 复审 loop R11:单窗陈旧/回归快照夹带别窗 entry 时,main 必须按 sender 真实 seq
  // 过滤,不能覆盖别窗持久化段(否则跨窗 workspace/tab/展开态被一个窗口的陈旧写回滚)。
  it('R11: explorer:write 丢弃非 sender windowSeq 的 foreign 段,不覆盖别窗', async () => {
    setWindowSeq(101, 1); // sender A 的真实窗口段 = seq 1
    const current = defaultExplorerV3();
    current.windows = [
      {
        windowSeq: 1,
        workspace: { root: '/old-a' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: { version: 1, panel: 'A' },
      },
      {
        windowSeq: 2,
        workspace: { root: '/keep-b' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: { version: 1, panel: 'B' },
      },
    ];
    await writeExplorer(current);

    // sender A(seq=1)的陈旧 payload 夹带了别窗 B(seq=2)的旧 entry,企图回滚 B 的 root。
    const result = await invokeIpc('explorer:write', {
      version: 3,
      workspace: { recentRoots: [] },
      pinned: { paths: [] },
      nextWindowSeq: 3,
      windows: [
        {
          windowSeq: 1,
          workspace: { root: '/new-a' },
          explorer: { activePath: null, expandedPaths: [], sort },
        },
        {
          windowSeq: 2,
          workspace: { root: '/EVIL-rollback-b' },
          explorer: { activePath: null, expandedPaths: [], sort },
        },
      ],
    });
    const saved = await loadExplorer(explorerFile);

    expect(result).toEqual({ ok: true, data: undefined });
    // 自己段(seq 1)写入生效
    expect(saved?.windows.find((w) => w.windowSeq === 1)?.workspace.root).toBe('/new-a');
    // 别窗段(seq 2)保持磁盘原值,foreign 段被丢弃,未被回滚
    expect(saved?.windows.find((w) => w.windowSeq === 2)?.workspace.root).toBe('/keep-b');
  });

  it('T25: layout:write on cold start creates explorer.json and current window entry', async () => {
    setWindowSeq(101, 4);

    const result = await invokeIpc('layout:write', {
      version: 1,
      panel: 'cold-start',
    });
    const saved = await loadExplorer(explorerFile);

    expect(result).toEqual({ ok: true, data: undefined });
    expect(saved?.version).toBe(3);
    expect(saved?.windows.find((w) => w.windowSeq === 4)).toMatchObject({
      windowSeq: 4,
      workspace: { root: null },
      layout: { version: 1, panel: 'cold-start' },
    });
  });
});
