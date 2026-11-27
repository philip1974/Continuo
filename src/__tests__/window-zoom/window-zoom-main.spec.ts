// BDD: window-zoom —— main 侧:window:set-zoom-level 统一套用到所有窗口、夹取、缓存与冷启动、每次加载覆盖 Chromium 按 URL
// 记的缩放、菜单缩放项为命令项。见同目录 README「关键行为」2、3、6。
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';

type InvokeHandler = (event: { sender: object; senderFrame: unknown }, raw: unknown) => Promise<unknown>;

class FakeContents extends EventEmitter {
  level = 0;
  destroyed = false;
  readonly setZoomLevel = vi.fn((l: number) => {
    this.level = l;
  });
  getZoomLevel(): number {
    return this.level;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

const h = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, InvokeHandler>(),
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: unknown }>,
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => h.userData), on: vi.fn(), name: 'Continuo' },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: { fromWebContents: vi.fn(() => ({ id: 1 })), getAllWindows: vi.fn(() => h.windows) },
  nativeTheme: { shouldUseDarkColors: true },
}));
vi.mock('../../../electron/main/persistence', () => ({ allocateWindowSeq: vi.fn() }));

import {
  _resetWindowZoomForTest,
  flushWindowZoomForTest,
  getWindowZoomLevel,
  loadWindowZoom,
  trackWindowZoom,
  WINDOW_ZOOM_FILE_NAME,
} from '../../../electron/main/services/window-zoom.service';
import { registerWindowIpc } from '../../../electron/main/ipc/window.ipc';
import { appMenuTemplate } from '../../../electron/main/app-menu';
import { hotkeyToAccelerator } from '../../../electron/main/menu-keybindings';
import type { MenuItemConstructorOptions } from 'electron';

const file = (): string => join(h.userData, WINDOW_ZOOM_FILE_NAME);
const setLevel = (raw: unknown): Promise<unknown> =>
  h.handlers.get(WINDOW_CHANNELS.SET_ZOOM_LEVEL)!({ sender: {}, senderFrame: { url: 'file:///app/index.html' } }, raw);

function addWindow(): FakeContents {
  const wc = new FakeContents();
  h.windows.push({ isDestroyed: () => false, webContents: wc });
  return wc;
}

async function restart(): Promise<void> {
  await flushWindowZoomForTest();
  _resetWindowZoomForTest();
  await loadWindowZoom();
}

beforeEach(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'continuo-window-zoom-'));
  h.handlers.clear();
  h.windows = [];
  _resetWindowZoomForTest();
  registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn(), rebuildAppMenu: vi.fn() });
});
afterEach(async () => {
  await flushWindowZoomForTest();
  rmSync(h.userData, { recursive: true, force: true });
});

describe('window:set-zoom-level', () => {
  it('立即套用到所有已开窗口(主窗 + popout 子窗),已相同的不重设', async () => {
    const main = addWindow();
    const popout = addWindow();
    const other = addWindow();
    other.level = 2;
    expect(await setLevel({ level: 2 })).toEqual({ ok: true, data: undefined });
    expect([main.level, popout.level, other.level]).toEqual([2, 2, 2]);
    expect(other.setZoomLevel).not.toHaveBeenCalled();
    expect(getWindowZoomLevel()).toBe(2);
  });

  it('越界夹到 [-8, 8];小数保留(VSCode 允许小数级别)', async () => {
    const wc = addWindow();
    await setLevel({ level: 99 });
    expect(wc.level).toBe(8);
    await setLevel({ level: -20 });
    expect(wc.level).toBe(-8);
    await setLevel({ level: 1.5 });
    expect(wc.level).toBe(1.5);
  });

  it('非数字 / 非有限 / 多余字段 / 缺字段 → 拒绝,不改任何窗口', async () => {
    const wc = addWindow();
    for (const raw of [{ level: '2' }, { level: Number.NaN }, { level: Infinity }, { level: 1, extra: 1 }, {}]) {
      expect(((await setLevel(raw)) as { ok: boolean }).ok, JSON.stringify(raw)).toBe(false);
    }
    expect(wc.setZoomLevel).not.toHaveBeenCalled();
    expect(getWindowZoomLevel()).toBe(0);
  });

  it('已销毁的窗口跳过', async () => {
    const wc = addWindow();
    wc.destroyed = true;
    await setLevel({ level: 1 });
    expect(wc.setZoomLevel).not.toHaveBeenCalled();
  });
});

describe('持久化与冷启动', () => {
  it('无缓存文件 → 0', async () => {
    await loadWindowZoom();
    expect(getWindowZoomLevel()).toBe(0);
  });

  it('设置后写入 userData/window-zoom.json;重启后为该级别', async () => {
    await setLevel({ level: 2 });
    await flushWindowZoomForTest();
    expect(JSON.parse(readFileSync(file(), 'utf-8'))).toEqual({ zoomLevel: 2 });
    await restart();
    expect(getWindowZoomLevel()).toBe(2);
  });

  it('连续设置只以最后一次为准;值未变不写盘', async () => {
    await setLevel({ level: 1 });
    await setLevel({ level: 3 });
    await flushWindowZoomForTest();
    expect(JSON.parse(readFileSync(file(), 'utf-8'))).toEqual({ zoomLevel: 3 });
    writeFileSync(file(), JSON.stringify({ zoomLevel: 3, marker: true }));
    await setLevel({ level: 3 });
    await flushWindowZoomForTest();
    expect(JSON.parse(readFileSync(file(), 'utf-8'))).toEqual({ zoomLevel: 3, marker: true });
  });

  it.each([
    ['JSON 损坏', '{oops'],
    ['字段非法', JSON.stringify({ zoomLevel: 'big' })],
    ['超大文件', JSON.stringify({ zoomLevel: 1, pad: 'x'.repeat(8 * 1024) })],
  ])('%s → 0,不抛', async (_label, text) => {
    writeFileSync(file(), text);
    await expect(loadWindowZoom()).resolves.toBeUndefined();
    expect(getWindowZoomLevel()).toBe(0);
  });

  it('缓存里越界的值读入时夹取', async () => {
    writeFileSync(file(), JSON.stringify({ zoomLevel: 42 }));
    await loadWindowZoom();
    expect(getWindowZoomLevel()).toBe(8);
  });
});

describe('每个窗口每次加载都套用统一级别(覆盖 Chromium 按 URL 记的缩放)', () => {
  it('did-navigate / did-finish-load(含 reload)→ 设为当前级别', async () => {
    await setLevel({ level: 2 });
    const wc = new FakeContents();
    trackWindowZoom(wc as never);
    wc.level = 0; // Chromium 按新 URL(?windowSeq=N / popout)给的缩放
    wc.emit('did-navigate');
    expect(wc.level).toBe(2);
    wc.level = 1; // per_host_zoom_levels 里旧 URL 的持久值
    wc.emit('did-finish-load');
    expect(wc.level).toBe(2);
  });

  it('接线:启动时先于首窗读缓存;browser-window-created(主窗 + popout)跟踪', () => {
    const src = readFileSync(resolve(__dirname, '../../../electron/main/index.ts'), 'utf-8');
    const boot = src.indexOf('loadWindowZoom()');
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(src.indexOf('createMainWindow({', boot));
    const created = src.indexOf("app.on('browser-window-created'");
    const track = src.indexOf('trackWindowZoom(win.webContents)');
    expect(created).toBeGreaterThan(-1);
    expect(track).toBeGreaterThan(created);
    expect(track).toBeLessThan(src.indexOf('});', src.indexOf("win.webContents.once('did-finish-load'", created)));
  });
});

describe('菜单「显示」的缩放项是命令项', () => {
  const flatten = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    items.flatMap((m) => [m, ...(Array.isArray(m.submenu) ? flatten(m.submenu) : [])]);

  it('不再用 role zoomIn / zoomOut / resetZoom;id 为 workbench.action.zoom*,accelerator 跟随 renderer 生效键位', () => {
    const keys: Record<string, string> = {
      'workbench.action.zoomIn': 'meta+=',
      'workbench.action.zoomOut': 'meta+-',
      'workbench.action.zoomReset': 'meta+0',
    };
    const items = flatten(
      appMenuTemplate(
        (k) => k,
        { newWindow: vi.fn(), openFolderInNewWindow: vi.fn(), reloadWindow: vi.fn() },
        true,
        (id) => (keys[id] ? hotkeyToAccelerator(keys[id]!, true) : undefined),
      ),
    );
    expect(items.some((m) => m.role === 'zoomIn' || m.role === 'zoomOut' || m.role === 'resetZoom')).toBe(false);
    const acc = (id: string) => items.find((m) => m.id === id)?.accelerator;
    expect(acc('workbench.action.zoomIn')).toBe('Command+=');
    expect(acc('workbench.action.zoomOut')).toBe('Command+-');
    expect(acc('workbench.action.zoomReset')).toBe('Command+0');
  });
});
