// BDD:切换窗口的窗口列表与聚焦(main)。见同目录 README.md。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { listSwitchWindows, type SwitchWindowLike } from '../../../electron/main/services/window-switch.service';

type InvokeHandler = (event: { sender: object; senderFrame: { url: string } }, raw: unknown) => Promise<unknown>;

interface FakeWin extends SwitchWindowLike {
  title: string;
  visible: boolean;
  minimized: boolean;
  destroyed: boolean;
  owner: FakeWin | null;
  frameName: string;
  focus: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  webContents: { isDestroyed(): boolean; mainFrame: { name: string } };
}

const h = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  windows: [] as unknown[],
  senderToWindow: new Map<object, unknown>(),
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
    fromId: vi.fn(() => null),
    getAllWindows: vi.fn(() => h.windows),
  },
}));
vi.mock('../../../electron/main/persistence', () => ({ allocateWindowSeq: vi.fn(), loadExplorer: async () => null }));
// 所属主窗:主窗即自身,popout 子窗 → 打开它的主窗
vi.mock('../../../electron/main/lib/menu-command', () => ({
  menuCommandTargetWindow: (w: FakeWin) => w.owner,
}));

import { registerWindowIpc } from '../../../electron/main/ipc/window.ipc';

function win(id: number, title: string, over: Partial<Pick<FakeWin, 'visible' | 'minimized' | 'frameName'>> & { parent?: FakeWin | null } = {}): FakeWin {
  const w = {
    id,
    title,
    visible: over.visible ?? true,
    minimized: over.minimized ?? false,
    destroyed: false,
    owner: null as FakeWin | null,
    frameName: over.frameName ?? '',
    focus: vi.fn(),
    restore: vi.fn(),
    isDestroyed: () => w.destroyed,
    isVisible: () => w.visible,
    isMinimized: () => w.minimized,
    getTitle: () => w.title,
    webContents: { isDestroyed: () => false, mainFrame: { name: over.frameName ?? '' } },
  } as FakeWin;
  w.owner = over.parent === undefined ? w : over.parent;
  h.windows.push(w);
  return w;
}

const sender = {};
const call = (channel: string, raw: unknown) => {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`missing ${channel}`);
  return handler({ sender, senderFrame: { url: 'file:///renderer/index.html' } }, raw);
};

beforeEach(() => {
  h.handlers.clear();
  h.windows.length = 0;
  h.senderToWindow.clear();
  registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn(), rebuildAppMenu: vi.fn() });
});

describe('listSwitchWindows', () => {
  it('主窗口按创建顺序,各自的 popout 子窗紧随其后;标出当前窗口', () => {
    const b = win(3, 'B — ws-b');
    const a = win(1, 'A — ws-a');
    const pa = win(5, 'a.ts — ws-a', { parent: a });
    const pb = win(4, 'term — ws-b', { parent: b });
    const owner = (w: FakeWin) => w.owner;
    expect(listSwitchWindows([b, a, pa, pb], owner, pa)).toEqual([
      { id: 1, title: 'A — ws-a', parentId: null, current: false },
      { id: 5, title: 'a.ts — ws-a', parentId: 1, current: true },
      { id: 3, title: 'B — ws-b', parentId: null, current: false },
      { id: 4, title: 'term — ws-b', parentId: 3, current: false },
    ]);
  });

  it('正在关闭(隐藏且未最小化)/ 已销毁 / 找不到所属主窗的不列;最小化的照列', () => {
    const a = win(1, 'A');
    const closing = win(2, 'closing', { visible: false });
    const mini = win(3, 'mini', { visible: false, minimized: true });
    const orphan = win(4, 'orphan', { parent: null });
    const gone = win(5, 'gone');
    gone.destroyed = true;
    const ids = listSwitchWindows([a, closing, mini, orphan, gone], (w) => w.owner, a).map((e) => e.id);
    expect(ids).toEqual([1, 3]);
  });
});

describe('window:list-windows / window:focus-window', () => {
  it('当前窗口 = 发起方;带 popoutName → 发起方打开的那个子窗', async () => {
    const a = win(1, 'A');
    win(2, 'child', { parent: a, frameName: 'dv-popout-1' });
    h.senderToWindow.set(sender, a);
    const own = (await call(WINDOW_CHANNELS.LIST_WINDOWS, {})) as { ok: true; data: { id: number; current: boolean }[] };
    expect(own.data.filter((e) => e.current).map((e) => e.id)).toEqual([1]);
    const fromChild = (await call(WINDOW_CHANNELS.LIST_WINDOWS, { popoutName: 'dv-popout-1' })) as typeof own;
    expect(fromChild.data.filter((e) => e.current).map((e) => e.id)).toEqual([2]);
  });

  it('聚焦所选窗口;最小化的先还原', async () => {
    const a = win(1, 'A');
    const b = win(2, 'B', { visible: false, minimized: true });
    h.senderToWindow.set(sender, a);
    expect(await call(WINDOW_CHANNELS.FOCUS_WINDOW, { id: 2 })).toEqual({ ok: true, data: undefined });
    expect(b.restore).toHaveBeenCalled();
    expect(b.focus).toHaveBeenCalled();
  });

  it('不在列表里的窗口(正在关闭 / 不存在)→ NO_WINDOW,不聚焦', async () => {
    const a = win(1, 'A');
    const closing = win(2, 'closing', { visible: false });
    h.senderToWindow.set(sender, a);
    const r = (await call(WINDOW_CHANNELS.FOCUS_WINDOW, { id: 2 })) as { ok: boolean; code?: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_WINDOW');
    expect(closing.focus).not.toHaveBeenCalled();
    expect(((await call(WINDOW_CHANNELS.FOCUS_WINDOW, { id: 99 })) as { ok: boolean }).ok).toBe(false);
  });
});
