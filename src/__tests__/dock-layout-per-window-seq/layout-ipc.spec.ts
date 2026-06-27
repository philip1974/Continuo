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
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
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
    expect(useExplorerStore.getState().expandedPaths).toEqual(new Set(['/work']));

    useWorkspaceStore.setState({ root: '/renderer', recentRoots: ['/renderer'] });
    useExplorerStore.setState({
      expandedPaths: new Set(['/renderer']),
      sort: { by: 'mtime', reverse: true },
    });
    const writable = snapshotFromStores(fullSnapshotWithMainOwned);
    const w0 = writable.windows[0]! as unknown as Record<string, unknown>;

    expect(writable.version).toBe(3);
    expect(w0).not.toHaveProperty('layout');
    expect(w0).not.toHaveProperty('lastClosedAt');
    expect(writable.windows[0]!.workspace.root).toBe('/renderer');
    // 打磨 R18:explorer.activePath 已不在 store,snapshot 写保留位 null。
    expect(writable.windows[0]!.explorer.activePath).toBeNull();
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

  // 边界(E215,E89 写端对偶):layout:read 读端复用写端 JSON-safe + 字节上限。旧版/手工污染的
  // explorer.json 可含 >2MiB(MAX_LAYOUT_BYTES)但 <16MiB(文件上限)的合法 JSON layout → 读端返 null
  //(renderer 走默认布局),不让 renderer fromJSON 处理超大 layout 放大。
  it('E215: layout:read 超大持久化 layout(>2MiB)→ 返回 null(走默认布局)', async () => {
    setWindowSeq(101, 7);
    const payload = defaultExplorerV3();
    // >2MiB 但 <16MiB 的合法 JSON layout(loadExplorer 不拒,但读端守卫拒)。
    const huge = { version: 1, blob: 'x'.repeat(2 * 1024 * 1024 + 16) };
    payload.windows = [
      {
        windowSeq: 7,
        workspace: { root: '/a' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: huge,
      },
    ];
    await writeExplorer(payload);

    const result = await invokeIpc('layout:read', undefined);

    // 中和(读端去守卫直接 passthrough)→ data 为超大 huge,该断言失败。
    expect(result).toEqual({ ok: true, data: null });
  });

  // 边界(E261,E215 同入口对偶 / 读端 cap 绕过):explorer:read 返回完整 payload(含 windows[].layout),
  // layout 的 2MiB 读端 cap 此前只用于 layout:read。污染/旧版 explorer.json 的超大 layout 可经 explorer:read
  // 绕过 layout 读 cap → renderer hydrate 无谓传输巨大 layout。explorer:read 返回前对每个 window.layout
  // 复用 sanitizeReadLayout:超限剥离(renderer 走默认布局),合法保留。
  it('E261: explorer:read 剥离超大 window.layout(>2MiB),保留合法 layout 与其它字段', async () => {
    const payload = defaultExplorerV3();
    const huge = { version: 1, blob: 'x'.repeat(2 * 1024 * 1024 + 16) }; // >2MiB <16MiB
    const okLayout = { version: 1, panel: 'B' };
    payload.windows = [
      {
        windowSeq: 7,
        workspace: { root: '/a' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: huge,
      },
      {
        windowSeq: 8,
        workspace: { root: '/b' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: okLayout,
      },
    ];
    await writeExplorer(payload);

    const result = (await invokeIpc('explorer:read', undefined)) as {
      ok: true;
      data: ExplorerPayloadV3;
    };
    expect(result.ok).toBe(true);
    const wins = result.data.windows;
    // 超大 layout 被剥离(走默认布局),但窗口其它字段保留
    const w7 = wins.find((w) => w.windowSeq === 7)!;
    expect(w7.layout).toBeUndefined();
    expect(w7.workspace.root).toBe('/a');
    // 合法 layout 原样保留
    const w8 = wins.find((w) => w.windowSeq === 8)!;
    expect(w8.layout).toEqual(okLayout);
  });

  it('E261: explorer:read 无 layout 的窗口原样返回(回归)', async () => {
    const payload = defaultExplorerV3();
    payload.windows = [
      {
        windowSeq: 7,
        workspace: { root: '/a' },
        explorer: { activePath: null, expandedPaths: [], sort },
      },
    ];
    await writeExplorer(payload);

    const result = (await invokeIpc('explorer:read', undefined)) as {
      ok: true;
      data: ExplorerPayloadV3;
    };
    expect(result.ok).toBe(true);
    expect(result.data.windows[0]!.workspace.root).toBe('/a');
    expect(result.data.windows[0]!.layout).toBeUndefined();
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

  // 边界(E89,E67 对偶):layout:write 序列化字节上限,防超大 layout 撑爆 explorer.json 致
  // 下次 loadExplorer 命中 16MiB 上限拒读 + 写路径 fail-closed。
  it('E89: layout:write 超 2MiB → PAYLOAD_TOO_LARGE 且旧 layout 保留', async () => {
    setWindowSeq(101, 7);
    const payload = defaultExplorerV3();
    payload.windows = [
      {
        windowSeq: 7,
        workspace: { root: '/a' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: { version: 1, panel: 'old-A' },
      },
    ];
    await writeExplorer(payload);

    const huge = { version: 1, blob: 'x'.repeat(2 * 1024 * 1024 + 100) };
    const result = (await invokeIpc('layout:write', huge)) as {
      ok: boolean;
      code?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PAYLOAD_TOO_LARGE');
    // 写被拒 → 旧 layout 原样保留(未覆盖)
    const saved = await loadExplorer(explorerFile);
    expect(saved?.windows.find((w) => w.windowSeq === 7)?.layout).toEqual({
      version: 1,
      panel: 'old-A',
    });
  });

  // 边界(E119,E105/E117 同族):LayoutSchema 是 .passthrough(),layout 含 Infinity/NaN/undefined
  //(structured-clone 经 IPC 保留)只判 stringify 大小会被静默改写(→null/丢字段)→ 重启后与
  // 内存态不一致。写盘前 assertJsonValue 拒非 JSON 安全值,旧 layout 保留。
  it('E119: layout:write 含非 JSON 安全值(Infinity/NaN)→ BAD_INPUT 且旧 layout 保留', async () => {
    setWindowSeq(101, 7);
    const payload = defaultExplorerV3();
    payload.windows = [
      {
        windowSeq: 7,
        workspace: { root: '/a' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: { version: 1, panel: 'old-A' },
      },
    ];
    await writeExplorer(payload);

    for (const bad of [
      { version: 1, params: { x: Infinity } },
      { version: 1, params: { x: NaN } },
      { version: 1, params: { keep: 1, drop: undefined } },
    ]) {
      const result = (await invokeIpc('layout:write', bad)) as {
        ok: boolean;
        code?: string;
      };
      expect(result.ok).toBe(false);
      expect(result.code).toBe('BAD_INPUT');
    }
    // 写被拒 → 旧 layout 原样保留
    const saved = await loadExplorer(explorerFile);
    expect(saved?.windows.find((w) => w.windowSeq === 7)?.layout).toEqual({
      version: 1,
      panel: 'old-A',
    });
  });

  it('E119: layout:write 正常 JSON-safe layout → 仍写入', async () => {
    setWindowSeq(101, 7);
    await writeExplorer(defaultExplorerV3());
    const result = (await invokeIpc('layout:write', {
      version: 1,
      panel: 'A',
      params: { n: 42, s: 'ok', nested: { arr: [1, 2, 3] } },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
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
