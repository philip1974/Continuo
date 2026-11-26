// 窗口底色主题跨进程重启持久化(冷启动首窗不闪色)。见同目录 README「冷启动」一节。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { WINDOW_BACKGROUND_COLORS } from '../../../electron/shared/window-background';

type InvokeHandler = (event: { sender: object; senderFrame: unknown }, raw: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, InvokeHandler>(),
  nativeTheme: { shouldUseDarkColors: true },
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => h.userData), on: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: { fromWebContents: vi.fn(() => ({ id: 1 })), getAllWindows: vi.fn(() => []) },
  nativeTheme: h.nativeTheme,
}));
vi.mock('../../../electron/main/persistence', () => ({ allocateWindowSeq: vi.fn() }));

import {
  _resetWindowThemeForTest,
  flushWindowThemeForTest,
  getWindowTheme,
  loadWindowTheme,
  WINDOW_THEME_FILE_NAME,
} from '../../../electron/main/services/window-theme.service';
import { currentWindowBackgroundColor, registerWindowIpc } from '../../../electron/main/ipc/window.ipc';

const file = (): string => join(h.userData, WINDOW_THEME_FILE_NAME);
const notify = (raw: unknown): Promise<unknown> =>
  h.handlers.get(WINDOW_CHANNELS.NOTIFY_THEME)!({ sender: {}, senderFrame: { url: 'file:///app/index.html' } }, raw);

/** 模拟进程重启:清内存态后重新从 userData 读。 */
async function restart(): Promise<void> {
  await flushWindowThemeForTest();
  _resetWindowThemeForTest();
  await loadWindowTheme();
}

beforeEach(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'continuo-window-theme-'));
  h.nativeTheme.shouldUseDarkColors = true;
  h.handlers.clear();
  _resetWindowThemeForTest();
  registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn(), rebuildAppMenu: vi.fn() });
});
afterEach(() => {
  rmSync(h.userData, { recursive: true, force: true });
});

describe('冷启动:窗口底色用上次持久化的主题', () => {
  it('无持久化文件 → 默认暗色', async () => {
    await loadWindowTheme();
    expect(getWindowTheme()).toBe('dark');
    expect(currentWindowBackgroundColor()).toBe(WINDOW_BACKGROUND_COLORS.dark);
  });

  it('上报 light → 写入 userData;重启后新窗口底色 = light', async () => {
    await notify({ theme: 'light', mode: 'light' });
    await flushWindowThemeForTest();
    expect(JSON.parse(readFileSync(file(), 'utf-8'))).toMatchObject({ theme: 'light', mode: 'light' });
    await restart();
    expect(getWindowTheme()).toBe('light');
    expect(currentWindowBackgroundColor()).toBe(WINDOW_BACKGROUND_COLORS.light);
  });

  it('只给 theme(无 mode)也合法;再上报 dark 覆盖,重启后为 dark', async () => {
    await notify({ theme: 'light' });
    await notify({ theme: 'dark' });
    await restart();
    expect(getWindowTheme()).toBe('dark');
  });

  it.each([
    [false, 'light'],
    [true, 'dark'],
  ] as const)('system 模式:重启时按 OS 当前外观(shouldUseDarkColors=%s → %s),不用上次解析值', async (osDark, expected) => {
    await notify({ theme: osDark ? 'light' : 'dark', mode: 'system' });
    h.nativeTheme.shouldUseDarkColors = osDark;
    await restart();
    expect(getWindowTheme()).toBe(expected);
    expect(currentWindowBackgroundColor()).toBe(WINDOW_BACKGROUND_COLORS[expected]);
  });

  it.each([
    ['JSON 损坏', '{not json'],
    ['字段非法', JSON.stringify({ theme: '#fff' })],
    ['超大文件', JSON.stringify({ theme: 'light', pad: 'x'.repeat(64 * 1024) })],
  ])('持久化文件%s → 回退暗色,不抛', async (_label, content) => {
    writeFileSync(file(), content);
    await expect(loadWindowTheme()).resolves.toBeUndefined();
    expect(getWindowTheme()).toBe('dark');
  });

  it('非法 mode 拒绝且不改状态 / 不落盘', async () => {
    const r = await notify({ theme: 'light', mode: 'auto' });
    expect(r).toMatchObject({ ok: false });
    await flushWindowThemeForTest();
    expect(getWindowTheme()).toBe('dark');
    expect(() => readFileSync(file())).toThrow();
  });
});

describe('启动接线', () => {
  it('index.ts 在创建首个窗口前 await loadWindowTheme()(与 loadSettings 同批)', () => {
    const src = readFileSync(resolve(__dirname, '../../../electron/main/index.ts'), 'utf-8');
    const block = src.match(/await Promise\.all\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
    expect(block).toContain('loadSettings()');
    expect(block).toContain('loadWindowTheme()');
    const firstWindow = src.search(/createMainWindow\(\{\s*windowSeq: 0/);
    expect(firstWindow).toBeGreaterThan(0);
    expect(src.indexOf('loadWindowTheme()')).toBeLessThan(firstWindow);
  });
});
