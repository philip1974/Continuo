// BDD: high-contrast-theme —— main 侧系统配色判定(VSCode ThemeMainService.getColorScheme 逐平台)、GET / 广播通道、
// system 模式冷启动底色含高对比度、notify-theme 接受四值主题。见同目录 README「2」。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_COLOR_SCHEME_CHANNELS,
  hostColorSchemeFromNativeTheme,
  isHostColorScheme,
  systemResolvedTheme,
} from '../../../electron/shared/host-color-scheme';
import { WINDOW_BACKGROUND_COLORS } from '../../../electron/shared/window-background';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';

type Handler = (event: { sender: object; senderFrame: unknown }, raw: unknown) => Promise<unknown>;

const m = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, Handler>(),
  nativeListeners: new Map<string, () => void>(),
  nativeTheme: {
    shouldUseDarkColors: true,
    shouldUseHighContrastColors: false,
    shouldUseInvertedColorScheme: false,
    on: (name: string, cb: () => void) => m.nativeListeners.set(name, cb),
  },
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> }; setBackgroundColor: ReturnType<typeof vi.fn> }>,
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => m.userData), on: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, fn: Handler) => m.handlers.set(channel, fn)) },
  BrowserWindow: { fromWebContents: vi.fn(() => ({ id: 1 })), getAllWindows: () => m.windows },
  nativeTheme: m.nativeTheme,
}));
vi.mock('../../../electron/main/persistence', () => ({ allocateWindowSeq: vi.fn() }));

import { registerHostColorSchemeIpc } from '../../../electron/main/ipc/host-color-scheme.ipc';
import { currentWindowBackgroundColor, registerWindowIpc } from '../../../electron/main/ipc/window.ipc';
import {
  _resetWindowThemeForTest,
  flushWindowThemeForTest,
} from '../../../electron/main/services/window-theme.service';

const TRUSTED = { sender: {}, senderFrame: { url: 'file:///app/index.html' } };
const invoke = (channel: string, raw?: unknown): Promise<unknown> => m.handlers.get(channel)!(TRUSTED, raw);
const nt = (p: Partial<{ dark: boolean; hc: boolean; inverted: boolean }>) => ({
  shouldUseDarkColors: p.dark ?? false,
  shouldUseHighContrastColors: p.hc ?? false,
  shouldUseInvertedColorScheme: p.inverted ?? false,
});
const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { configurable: true, value: p });
};
const win = () => ({ isDestroyed: () => false, webContents: { send: vi.fn() }, setBackgroundColor: vi.fn() });

beforeEach(() => {
  m.userData = mkdtempSync(join(tmpdir(), 'continuo-hc-'));
  m.handlers.clear();
  m.nativeListeners.clear();
  Object.assign(m.nativeTheme, { shouldUseDarkColors: true, shouldUseHighContrastColors: false, shouldUseInvertedColorScheme: false });
  m.windows = [];
  _resetWindowThemeForTest();
});
afterEach(async () => {
  setPlatform(realPlatform);
  await flushWindowThemeForTest();
  rmSync(m.userData, { recursive: true, force: true });
});

describe('hostColorSchemeFromNativeTheme(VSCode getColorScheme)', () => {
  it('Windows:高对比度 = shouldUseHighContrastColors,明暗 = shouldUseInvertedColorScheme', () => {
    expect(hostColorSchemeFromNativeTheme('win32', nt({ hc: true, inverted: true }))).toEqual({ dark: true, highContrast: true });
    expect(hostColorSchemeFromNativeTheme('win32', nt({ hc: true, inverted: false, dark: true }))).toEqual({
      dark: false,
      highContrast: true,
    });
    // 只有反转、无高对比度:Windows 不算
    expect(hostColorSchemeFromNativeTheme('win32', nt({ inverted: true, dark: true }))).toEqual({ dark: true, highContrast: false });
  });

  it('macOS:「增强对比度」或「反转颜色」都算高对比度,明暗按外观', () => {
    expect(hostColorSchemeFromNativeTheme('darwin', nt({ hc: true, dark: false }))).toEqual({ dark: false, highContrast: true });
    expect(hostColorSchemeFromNativeTheme('darwin', nt({ inverted: true, dark: true }))).toEqual({ dark: true, highContrast: true });
    expect(hostColorSchemeFromNativeTheme('darwin', nt({ dark: true }))).toEqual({ dark: true, highContrast: false });
  });

  it('Linux:高对比度按暗色', () => {
    expect(hostColorSchemeFromNativeTheme('linux', nt({ hc: true, dark: false }))).toEqual({ dark: true, highContrast: true });
    expect(hostColorSchemeFromNativeTheme('linux', nt({ inverted: true }))).toEqual({ dark: false, highContrast: false });
  });

  it('systemResolvedTheme:高对比度 → hcDark / hcLight,否则 dark / light', () => {
    expect(systemResolvedTheme({ dark: true, highContrast: true })).toBe('hcDark');
    expect(systemResolvedTheme({ dark: false, highContrast: true })).toBe('hcLight');
    expect(systemResolvedTheme({ dark: true, highContrast: false })).toBe('dark');
    expect(systemResolvedTheme({ dark: false, highContrast: false })).toBe('light');
  });

  it('payload 守卫只认 { dark: boolean, highContrast: boolean }', () => {
    expect(isHostColorScheme({ dark: true, highContrast: false })).toBe(true);
    for (const bad of [null, {}, { dark: 1, highContrast: false }, { dark: true }, 'x']) {
      expect(isHostColorScheme(bad)).toBe(false);
    }
  });
});

describe('main 通道', () => {
  it('GET 返回当前判定;nativeTheme updated → 广播到所有窗口(主窗 + popout)', async () => {
    setPlatform('darwin');
    const [a, b] = [win(), win()];
    m.windows = [a, b];
    registerHostColorSchemeIpc();
    expect(await invoke(HOST_COLOR_SCHEME_CHANNELS.GET)).toEqual({ ok: true, data: { dark: true, highContrast: false } });
    m.nativeTheme.shouldUseHighContrastColors = true; // macOS「增强对比度」
    m.nativeListeners.get('updated')!();
    for (const w of [a, b]) {
      expect(w.webContents.send).toHaveBeenCalledWith(HOST_COLOR_SCHEME_CHANNELS.CHANGED, { dark: true, highContrast: true });
    }
    expect(await invoke(HOST_COLOR_SCHEME_CHANNELS.GET)).toEqual({ ok: true, data: { dark: true, highContrast: true } });
  });

  it('notify-theme 接受四值主题与五值模式;HC 底色 #000000 / #ffffff 推到所有窗口', async () => {
    const w = win();
    m.windows = [w];
    registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn(), rebuildAppMenu: vi.fn() });
    await invoke(WINDOW_CHANNELS.NOTIFY_THEME, { theme: 'hcDark', mode: 'hcDark' });
    expect(w.setBackgroundColor).toHaveBeenLastCalledWith(WINDOW_BACKGROUND_COLORS.hcDark);
    expect(currentWindowBackgroundColor()).toBe('#000000');
    await invoke(WINDOW_CHANNELS.NOTIFY_THEME, { theme: 'hcLight', mode: 'hcLight' });
    expect(currentWindowBackgroundColor()).toBe('#ffffff');
    expect(await invoke(WINDOW_CHANNELS.NOTIFY_THEME, { theme: 'hc' })).toMatchObject({ ok: false });
    expect(currentWindowBackgroundColor()).toBe('#ffffff');
  });

  it('system 模式:新窗口底色按 OS 当前配色(含高对比度)', async () => {
    setPlatform('win32');
    registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn(), rebuildAppMenu: vi.fn() });
    await invoke(WINDOW_CHANNELS.NOTIFY_THEME, { theme: 'dark', mode: 'system' });
    expect(currentWindowBackgroundColor()).toBe(WINDOW_BACKGROUND_COLORS.dark);
    // Windows 高对比度白:shouldUseInvertedColorScheme=false → HC 浅
    m.nativeTheme.shouldUseHighContrastColors = true;
    expect(currentWindowBackgroundColor()).toBe(WINDOW_BACKGROUND_COLORS.hcLight);
    m.nativeTheme.shouldUseInvertedColorScheme = true;
    expect(currentWindowBackgroundColor()).toBe(WINDOW_BACKGROUND_COLORS.hcDark);
  });
});
