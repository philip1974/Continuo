// @vitest-environment jsdom
// BDD: high-contrast-theme —— 主题项与切换、「跟随系统」+ 系统高对比度自动切、首帧 class、编辑器 / 终端随之切换。
// 见同目录 README「1. 主题项与切换」「2. 跟随系统 + 系统高对比度」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { HostColorScheme } from '../../../electron/shared/host-color-scheme';

const h = vi.hoisted(() => ({
  host: null as HostColorScheme | null,
  hostListeners: new Set<(s: HostColorScheme) => void>(),
  popoutDocs: [] as Document[],
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    window: {
      notifyTheme: vi.fn(async () => ({ ok: true })),
      getHostColorScheme: vi.fn(async () =>
        h.host === null ? { ok: false, code: 'X', message: 'x' } : { ok: true, data: h.host },
      ),
      onHostColorSchemeChanged: (cb: (s: HostColorScheme) => void) => {
        h.hostListeners.add(cb);
        return () => h.hostListeners.delete(cb);
      },
    },
  },
}));
vi.mock('@/shell/dock/popout-documents', async (orig) => ({
  ...(await orig<object>()),
  getPopoutDocuments: () => h.popoutDocs,
  subscribePopoutDocuments: () => () => {},
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));

import { ThemeProvider, useTheme } from '@/theme';
import { _resetHostColorSchemeForTest } from '@/theme/host-color-scheme';
import { applyInitialThemeClass, readInitialTheme } from '@/theme/initial-theme';
import { useSettingsValuesStore } from '@/plugins/settings/values-store';
import { GENERAL_THEME } from '@/plugins/settings/core-setting-specs';
import { SETTINGS_VALUES_STORAGE_KEY } from '@/plugins/settings/storage-key';
import { openThemePicker, toggleLightDarkThemes } from '@/plugins/theme-picker/theme-commands';
import { ThemePickerModal } from '@/plugins/theme-picker/ThemePickerModal';
import { useThemePickerStore } from '@/plugins/theme-picker/store';
import { codeEditorTheme } from '@/panels/Editor/code-editor-theme';
import { terminalColorFgBg } from '@/shell/dock/create-user-terminal';
import {
  getTerminalSearchDecorations,
  invalidateTerminalSearchDecorations,
} from '@/panels/Terminal/terminal-search-state';
import { setLocale } from '@/i18n';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const html = document.documentElement;
const classes = (doc: Document = document): string[] =>
  ['dark', 'hc-black', 'hc-light'].filter((c) => doc.documentElement.classList.contains(c));
const setTheme = (v: string): void => {
  act(() => useSettingsValuesStore.getState().setValue(GENERAL_THEME.id, v));
};
const storedTheme = (): unknown => useSettingsValuesStore.getState().values[GENERAL_THEME.id];

// 系统媒体查询(prefers-color-scheme / prefers-contrast / forced-colors)可控,change 事件可触发。
const media = { dark: true, contrastMore: false, forcedColors: false };
const mediaListeners = new Set<() => void>();
function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
      matches:
        q === '(prefers-color-scheme: dark)'
          ? media.dark
          : q === '(prefers-contrast: more)'
            ? media.contrastMore
            : q === '(forced-colors: active)'
              ? media.forcedColors
              : false,
      media: q,
      addEventListener: (_: string, cb: () => void) => mediaListeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => mediaListeners.delete(cb),
    }),
  });
  vi.stubGlobal('matchMedia', window.matchMedia);
}
function setMedia(next: Partial<typeof media>): void {
  Object.assign(media, next);
  act(() => {
    for (const l of [...mediaListeners]) l();
  });
}
function pushHost(next: HostColorScheme): void {
  h.host = next;
  act(() => {
    for (const l of [...h.hostListeners]) l(next);
  });
}

let ctx: ReturnType<typeof useTheme> | null = null;
function Probe() {
  ctx = useTheme();
  return null;
}
function mount() {
  return render(
    <ThemeProvider>
      <Probe />
      <ThemePickerModal />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  setLocale('en');
  Object.assign(media, { dark: true, contrastMore: false, forcedColors: false });
  mediaListeners.clear();
  installMatchMedia();
  h.host = null;
  h.hostListeners.clear();
  h.popoutDocs = [];
  _resetHostColorSchemeForTest();
  localStorage.clear();
  useSettingsValuesStore.getState().reset(GENERAL_THEME.id);
  html.classList.remove('dark', 'hc-black', 'hc-light');
  ctx = null;
});
afterEach(() => {
  cleanup();
  useThemePickerStore.getState().close();
  vi.unstubAllGlobals();
});

describe('1. 主题项', () => {
  it('general.theme 枚举 = 亮 / 暗 / 高对比度深 / 高对比度浅 / 跟随系统;三语文案', () => {
    expect(GENERAL_THEME.enum!.map((o) => o.value)).toEqual(['light', 'dark', 'hcDark', 'hcLight', 'system']);
    const keys = Object.fromEntries(GENERAL_THEME.enum!.map((o) => [o.value, o.labelKey as keyof typeof en]));
    expect(en[keys.hcDark!]).toBe('Dark High Contrast');
    expect(en[keys.hcLight!]).toBe('Light High Contrast');
    expect(zh[keys.hcDark!]).toBe('高对比度深色');
    expect(zh[keys.hcLight!]).toBe('高对比度浅色');
    expect(ko[keys.hcDark!]).toBe('고대비 다크');
    expect(ko[keys.hcLight!]).toBe('고대비 라이트');
  });

  it('颜色主题选择器同序同名列出五项', () => {
    mount();
    act(() => openThemePicker());
    const opts = screen.queryAllByRole('option');
    expect(opts.map((o) => o.getAttribute('data-theme-mode'))).toEqual(['light', 'dark', 'hcDark', 'hcLight', 'system']);
    expect(opts.map((o) => o.textContent)).toEqual([
      'Light',
      'DarkCurrent',
      'Dark High Contrast',
      'Light High Contrast',
      'System',
    ]);
  });
});

describe('1. 切换:<html> class 与 resolved', () => {
  it('hcDark → dark + hc-black;hcLight → 只有 hc-light;回到 dark → 无 hc-*;popout 子窗同步', () => {
    const child = document.implementation.createHTMLDocument('popout');
    h.popoutDocs = [child];
    mount();
    expect(classes()).toEqual(['dark']);

    setTheme('hcDark');
    expect(ctx!.resolved).toBe('hcDark');
    expect(classes()).toEqual(['dark', 'hc-black']);
    expect(classes(child)).toEqual(['dark', 'hc-black']);

    setTheme('hcLight');
    expect(ctx!.resolved).toBe('hcLight');
    expect(classes()).toEqual(['hc-light']);
    expect(classes(child)).toEqual(['hc-light']);

    setTheme('light');
    expect(classes()).toEqual([]);
    setTheme('dark');
    expect(classes()).toEqual(['dark']);
  });

  it('在浅色和深色主题之间切换:HC 深 ↔ HC 浅(亮 ↔ 暗不变)', () => {
    mount();
    setTheme('hcDark');
    act(() => toggleLightDarkThemes());
    expect(storedTheme()).toBe('hcLight');
    act(() => toggleLightDarkThemes());
    expect(storedTheme()).toBe('hcDark');
    setTheme('light');
    act(() => toggleLightDarkThemes());
    expect(storedTheme()).toBe('dark');
  });

  it('跟随系统且系统为高对比度暗色 → 切换写入高对比度浅色', () => {
    media.contrastMore = true;
    mount();
    setTheme('system');
    expect(ctx!.resolved).toBe('hcDark');
    act(() => toggleLightDarkThemes());
    expect(storedTheme()).toBe('hcLight');
  });
});

describe('2. 跟随系统 + 系统高对比度', () => {
  it('prefers-contrast: more → 按 prefers-color-scheme 选 HC 深 / 浅;关掉 → 回到普通亮 / 暗', () => {
    mount();
    setTheme('system');
    expect(ctx!.resolved).toBe('dark');
    setMedia({ contrastMore: true });
    expect(ctx!.resolved).toBe('hcDark');
    expect(classes()).toEqual(['dark', 'hc-black']);
    setMedia({ dark: false });
    expect(ctx!.resolved).toBe('hcLight');
    expect(classes()).toEqual(['hc-light']);
    setMedia({ contrastMore: false });
    expect(ctx!.resolved).toBe('light');
    expect(classes()).toEqual([]);
  });

  it('forced-colors: active(Windows 高对比度)同样切 HC', () => {
    media.dark = false;
    mount();
    setTheme('system');
    setMedia({ forcedColors: true });
    expect(ctx!.resolved).toBe('hcLight');
  });

  it('main 的 nativeTheme 判定(初值 + 推送)为高对比度 → 用 main 的明暗;推送关掉 → 回到媒体查询', async () => {
    media.dark = true; // 媒体查询看不到(如 macOS「反转颜色」),main 判定高对比度浅色
    h.host = { dark: false, highContrast: true };
    mount();
    setTheme('system');
    await act(async () => {});
    expect(ctx!.resolved).toBe('hcLight');
    pushHost({ dark: true, highContrast: true });
    expect(ctx!.resolved).toBe('hcDark');
    pushHost({ dark: true, highContrast: false });
    expect(ctx!.resolved).toBe('dark');
  });

  it('固定选了亮 / 暗主题时不随系统高对比度切换', () => {
    media.contrastMore = true;
    mount();
    setTheme('dark');
    expect(ctx!.resolved).toBe('dark');
    pushHost({ dark: true, highContrast: true });
    expect(ctx!.resolved).toBe('dark');
  });
});

describe('1. 首帧 class(initial-theme)', () => {
  const store = (v: string): void => localStorage.setItem(SETTINGS_VALUES_STORAGE_KEY, JSON.stringify({ [GENERAL_THEME.id]: v }));

  it('设置值 hcDark / hcLight 直接定 class', () => {
    store('hcDark');
    applyInitialThemeClass();
    expect(classes()).toEqual(['dark', 'hc-black']);
    store('hcLight');
    applyInitialThemeClass();
    expect(classes()).toEqual(['hc-light']);
    store('dark');
    applyInitialThemeClass();
    expect(classes()).toEqual(['dark']);
  });

  it('system + 系统高对比度(媒体查询)→ HC', () => {
    store('system');
    media.forcedColors = true;
    media.dark = false;
    expect(readInitialTheme()).toBe('hcLight');
    media.dark = true;
    expect(readInitialTheme()).toBe('hcDark');
  });
});

describe('1. 编辑器 / 终端随之切换', () => {
  it('codeEditorTheme:HC 深按暗色变体、HC 浅按亮色变体', () => {
    expect(codeEditorTheme('hcDark')).toBe(codeEditorTheme('dark'));
    expect(codeEditorTheme('hcLight')).toBe(codeEditorTheme('light'));
    expect(codeEditorTheme('hcLight')).not.toBe(codeEditorTheme('dark'));
  });

  it('新终端 COLORFGBG 按明暗:HC 浅 → 0;15,HC 深 → 15;0', () => {
    html.classList.add('hc-light');
    expect(terminalColorFgBg()).toBe('0;15');
    html.classList.remove('hc-light');
    html.classList.add('dark', 'hc-black');
    expect(terminalColorFgBg()).toBe('15;0');
  });

  it('终端搜索装饰色缓存按四值主题作键:暗色 → 高对比度深(同为 dark)也重读 token', () => {
    const names = [
      '--md-primary-container',
      '--md-primary',
      '--md-on-primary-container',
    ];
    const paint = (hex: string): void => {
      for (const n of names) html.style.setProperty(n, hex);
    };
    invalidateTerminalSearchDecorations();
    html.classList.add('dark');
    paint('#111111');
    expect(getTerminalSearchDecorations().matchBorder).toBe('#111111');
    html.classList.add('hc-black');
    paint('#f38518');
    expect(getTerminalSearchDecorations().matchBorder).toBe('#f38518');
    for (const n of names) html.style.removeProperty(n);
    invalidateTerminalSearchDecorations();
  });
});
