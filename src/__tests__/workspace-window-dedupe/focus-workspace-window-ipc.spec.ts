// 打开一个已在别的主窗口打开的文件夹 → 聚焦那个窗口,不改当前窗口 / 不再开新窗口(VSCode 同)。
// main 侧两个入口:window:focus-workspace-window(renderer 本窗口切换前询问)与 openWorkspaceWindowWith(新开窗口:
// 菜单 / Dock 菜单「在新窗口打开文件夹」、命令行 / second-instance、open-file、window.create)。
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';

type InvokeHandler = (event: { sender: object; senderFrame: { url: string } }, raw: unknown) => Promise<unknown>;

interface FakeWin {
  id: number;
  visible: boolean;
  minimized: boolean;
  destroyed: boolean;
  focus: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
}

const h = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  windows: new Map<number, unknown>(),
  senderToWindow: new Map<object, unknown>(),
  allocateWindowSeq: vi.fn(async () => 7),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), on: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    fromWebContents: vi.fn((sender: object) => h.senderToWindow.get(sender) ?? null),
    fromId: vi.fn((id: number) => h.windows.get(id) ?? null),
  },
}));
// loadExplorer:新窗口按文件夹会话快照建段(workspace-snapshot);盘上无文件 → 没有快照,照旧 fresh
vi.mock('../../../electron/main/persistence', () => ({ allocateWindowSeq: h.allocateWindowSeq, loadExplorer: async () => null }));

import { openWorkspaceWindowWith, registerWindowIpc } from '../../../electron/main/ipc/window.ipc';
import { _reset, setWorkspaceRoot } from '../../../electron/main/services/window-workspace-roots.service';

function fakeWin(id: number, over: Partial<Pick<FakeWin, 'visible' | 'minimized'>> = {}): FakeWin {
  const w: FakeWin = {
    id,
    visible: over.visible ?? true,
    minimized: over.minimized ?? false,
    destroyed: false,
    focus: vi.fn(),
    restore: vi.fn(() => {
      w.minimized = false;
    }),
    isDestroyed: () => w.destroyed,
    isVisible: () => w.visible,
    isMinimized: () => w.minimized,
  };
  h.windows.set(id, w);
  return w;
}

const sender = {};
function askFocus(root: string): Promise<unknown> {
  const handler = h.handlers.get(WINDOW_CHANNELS.FOCUS_WORKSPACE_WINDOW);
  if (!handler) throw new Error('missing FOCUS_WORKSPACE_WINDOW handler');
  return handler({ sender, senderFrame: { url: 'file:///renderer/index.html' } }, { root });
}

let current: FakeWin;
beforeEach(() => {
  h.handlers.clear();
  h.windows.clear();
  h.senderToWindow.clear();
  _reset();
  vi.clearAllMocks();
  current = fakeWin(1);
  h.senderToWindow.set(sender, current);
  registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn() });
});

describe('window:focus-workspace-window(本窗口打开文件夹前询问)', () => {
  it('别的主窗口已打开该文件夹 → 聚焦那个窗口,返回 true', async () => {
    const other = fakeWin(2);
    setWorkspaceRoot(2, '/u/ws-x');
    expect(await askFocus('/u/ws-x')).toEqual({ ok: true, data: true });
    expect(other.focus).toHaveBeenCalledTimes(1);
    expect(current.focus).not.toHaveBeenCalled();
  });

  it('那个窗口最小化 → 先还原再聚焦', async () => {
    const other = fakeWin(2, { minimized: true, visible: false });
    setWorkspaceRoot(2, '/u/ws-x');
    expect(await askFocus('/u/ws-x')).toEqual({ ok: true, data: true });
    expect(other.restore).toHaveBeenCalledTimes(1);
    expect(other.focus).toHaveBeenCalledTimes(1);
  });

  it('没有别的窗口打开它 → false,不聚焦任何窗口', async () => {
    const other = fakeWin(2);
    setWorkspaceRoot(2, '/u/ws-a');
    expect(await askFocus('/u/ws-x')).toEqual({ ok: true, data: false });
    expect(other.focus).not.toHaveBeenCalled();
  });

  it('当前窗口打开的就是它 → false(保持原行为),即使别的窗口也开着同一目录', async () => {
    const other = fakeWin(2);
    setWorkspaceRoot(1, '/u/ws-x');
    setWorkspaceRoot(2, '/u/ws-x');
    expect(await askFocus('/u/ws-x')).toEqual({ ok: true, data: false });
    expect(other.focus).not.toHaveBeenCalled();
  });

  it('关窗 / 退出流程中已隐藏的窗口不算', async () => {
    const closing = fakeWin(2, { visible: false });
    setWorkspaceRoot(2, '/u/ws-x');
    expect(await askFocus('/u/ws-x')).toEqual({ ok: true, data: false });
    expect(closing.focus).not.toHaveBeenCalled();
  });

  it('软链指向同一目录也算已打开(realpath 后比较)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ws-dedupe-'));
    try {
      const link = path.join(dir, 'link');
      const realDir = mkdtempSync(path.join(dir, 'r-'));
      symlinkSync(realDir, link);
      const other = fakeWin(2);
      setWorkspaceRoot(2, realDir);
      expect(await askFocus(link)).toEqual({ ok: true, data: true });
      expect(other.focus).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('openWorkspaceWindowWith(新开窗口打开文件夹)', () => {
  it('文件夹已在某个主窗口打开 → 聚焦它,不分配 windowSeq、不建窗', async () => {
    const other = fakeWin(2);
    setWorkspaceRoot(2, '/u/ws-x');
    const create = vi.fn(() => ({ id: 3 }));
    await openWorkspaceWindowWith(create, '/u/ws-x');
    expect(other.focus).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(h.allocateWindowSeq).not.toHaveBeenCalled();
  });

  it('当前(发起)窗口就开着它 → 也聚焦它,不再开第二个', async () => {
    setWorkspaceRoot(1, '/u/ws-x');
    const create = vi.fn(() => ({ id: 3 }));
    await openWorkspaceWindowWith(create, '/u/ws-x');
    expect(current.focus).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('没有窗口打开它 → 照常分配 seq 并 fresh 建窗', async () => {
    setWorkspaceRoot(1, '/u/ws-a');
    const create = vi.fn(() => ({ id: 3 }));
    await openWorkspaceWindowWith(create, '/u/ws-x');
    expect(create).toHaveBeenCalledWith({ windowSeq: 7, workspace: '/u/ws-x', fresh: true });
  });

  it('空白新窗口(不带文件夹)不受影响', async () => {
    setWorkspaceRoot(1, '/u/ws-a');
    const create = vi.fn(() => ({ id: 3 }));
    await openWorkspaceWindowWith(create);
    expect(create).toHaveBeenCalledWith({ windowSeq: 7 });
    expect(current.focus).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  _reset();
});
