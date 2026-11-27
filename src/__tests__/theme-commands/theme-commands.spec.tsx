// @vitest-environment jsdom
// BDD: theme-commands —— 首选项:颜色主题(workbench.action.selectTheme,上下移动即预览 / Enter 写设置 / Esc 恢复)与
// 在浅色和深色主题之间切换(workbench.action.toggleLightDarkThemes)。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const popout = vi.hoisted(() => ({ docs: [] as Document[], subs: new Set<() => void>() }));
vi.mock('@/shell/dock/popout-documents', async (orig) => ({
  ...(await orig<object>()),
  getPopoutDocuments: () => popout.docs,
  subscribePopoutDocuments: (cb: () => void) => {
    popout.subs.add(cb);
    return () => popout.subs.delete(cb);
  },
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));

import { ThemeProvider } from '@/theme';
import { ThemePickerModal } from '@/plugins/theme-picker/ThemePickerModal';
import { useThemePickerStore } from '@/plugins/theme-picker/store';
import {
  openThemePicker,
  SELECT_THEME_COMMAND_ID,
  themeCommandSpecs,
  TOGGLE_LIGHT_DARK_THEMES_COMMAND_ID,
} from '@/plugins/theme-picker/theme-commands';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { useOpenRecentStore } from '@/plugins/open-recent/store';
import { useSettingsValuesStore } from '@/plugins/settings/values-store';
import { GENERAL_THEME } from '@/plugins/settings/core-setting-specs';
import { POPOUT_HOTKEY_COMMAND_IDS } from '@/plugins/command-palette/useCommandHotkeys';
import { setLocale } from '@/i18n';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const theme = () => useSettingsValuesStore.getState().values[GENERAL_THEME.id];
const setTheme = (v: string) => useSettingsValuesStore.getState().setValue(GENERAL_THEME.id, v);
const isDark = (doc: Document = document) => doc.documentElement.classList.contains('dark');
const input = () => screen.getByRole('combobox');
const options = () => screen.queryAllByRole('option');
const selected = () => options().find((o) => o.getAttribute('aria-selected') === 'true')?.getAttribute('data-theme-mode');
const spec = (id: string) => themeCommandSpecs().find((c) => c.id === id)!;

/** OS 配色(prefers-color-scheme)。 */
function mockSystemDark(dark: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
      matches: q.includes('dark') ? dark : !dark,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

function renderApp() {
  return render(
    <ThemeProvider>
      <ThemePickerModal />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  setLocale('en');
  mockSystemDark(true);
  popout.docs = [];
  useSettingsValuesStore.getState().reset(GENERAL_THEME.id);
  useThemePickerStore.getState().close();
});
afterEach(() => {
  cleanup();
  useThemePickerStore.getState().close();
  useSettingsValuesStore.getState().reset(GENERAL_THEME.id);
});

describe('命令', () => {
  it('id 同 VSCode;首选项类别;无默认键(VSCode ⌘K ⌘T 是和弦);三语标题', () => {
    const ids = themeCommandSpecs().map((c) => c.id);
    expect(ids).toEqual(['workbench.action.selectTheme', 'workbench.action.toggleLightDarkThemes']);
    for (const c of themeCommandSpecs()) {
      expect(c.hotkey).toBeUndefined();
      expect(c.categoryKey).toBe('commands.preferences.category');
      for (const locale of [en, zh, ko]) expect(locale[c.titleKey as keyof typeof en]).toBeTruthy();
    }
    expect(en['commands.preferences.select_theme.title']).toBe('Color Theme');
    expect(zh['commands.preferences.select_theme.title']).toBe('颜色主题');
  });

  it('popout 子窗里也经热键分发(选择器画在按键所在子窗;切换只改设置)', () => {
    expect(POPOUT_HOTKEY_COMMAND_IDS.has(SELECT_THEME_COMMAND_ID)).toBe(true);
    expect(POPOUT_HOTKEY_COMMAND_IDS.has(TOGGLE_LIGHT_DARK_THEMES_COMMAND_ID)).toBe(true);
  });

  it('执行颜色主题:打开选择器,并关掉其它选择器(互斥)', () => {
    useQuickOpenStore.setState({ isOpen: true });
    useCommandPaletteStore.setState({ isOpen: true });
    useOpenRecentStore.setState({ isOpen: true });
    void spec(SELECT_THEME_COMMAND_ID).fn();
    expect(useThemePickerStore.getState().isOpen).toBe(true);
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    expect(useOpenRecentStore.getState().isOpen).toBe(false);
  });
});

describe('颜色主题选择器', () => {
  it('列出 亮色 / 暗色 / 跟随系统;选中当前主题,当前项标「当前」', () => {
    setTheme('light');
    renderApp();
    act(() => openThemePicker());
    expect(options().map((o) => o.getAttribute('data-theme-mode'))).toEqual(['light', 'dark', 'system']);
    expect(options().map((o) => o.textContent)).toEqual(['LightCurrent', 'Dark', 'System']);
    expect(selected()).toBe('light');
  });

  it('上下移动即预览(只改界面不写设置);Esc 关闭并恢复原主题', () => {
    setTheme('dark');
    renderApp();
    act(() => openThemePicker());
    expect(selected()).toBe('dark');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(selected()).toBe('light');
    expect(isDark()).toBe(false);
    expect(theme()).toBe('dark');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(useThemePickerStore.getState().isOpen).toBe(false);
    expect(isDark()).toBe(true);
    expect(theme()).toBe('dark');
  });

  it('Enter 写入设置并关闭(预览清除后仍是所选主题);单击同样确定', () => {
    setTheme('dark');
    renderApp();
    act(() => openThemePicker());
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(useThemePickerStore.getState().isOpen).toBe(false);
    expect(theme()).toBe('light');
    expect(isDark()).toBe(false);

    act(() => openThemePicker());
    fireEvent.click(screen.getByRole('option', { name: /Dark/ }));
    expect(theme()).toBe('dark');
    expect(isDark()).toBe(true);
  });

  it('输入过滤(本地化名称或英文模式名);无匹配 → 提示且回到原主题', () => {
    setLocale('zh');
    setTheme('dark');
    renderApp();
    act(() => openThemePicker());
    fireEvent.change(input(), { target: { value: 'light' } });
    expect(options().map((o) => o.getAttribute('data-theme-mode'))).toEqual(['light']);
    expect(isDark()).toBe(false);
    fireEvent.change(input(), { target: { value: 'zzz' } });
    expect(screen.getByRole('status').textContent).toBe(zh['theme_picker.no_match']);
    expect(isDark()).toBe(true);
  });

  it('预览同步到 popout 子窗的 <html>(子窗里打开的选择器预览可见);Esc 后子窗也恢复', () => {
    const child = document.implementation.createHTMLDocument('popout');
    child.documentElement.classList.add('dark');
    popout.docs = [child];
    setTheme('dark');
    renderApp();
    act(() => openThemePicker());
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(isDark(child)).toBe(false);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(isDark(child)).toBe(true);
  });

  it('选择器以其它方式关闭(所在子窗关闭等)→ 同样恢复原主题', () => {
    setTheme('dark');
    renderApp();
    act(() => openThemePicker());
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(selected()).toBe('light');
    act(() => useThemePickerStore.getState().close());
    expect(isDark()).toBe(true);
    expect(theme()).toBe('dark');
  });
});

describe('在浅色和深色主题之间切换', () => {
  it('暗 → 亮,亮 → 暗', () => {
    renderApp();
    setTheme('dark');
    act(() => void spec(TOGGLE_LIGHT_DARK_THEMES_COMMAND_ID).fn());
    expect(theme()).toBe('light');
    expect(isDark()).toBe(false);
    act(() => void spec(TOGGLE_LIGHT_DARK_THEMES_COMMAND_ID).fn());
    expect(theme()).toBe('dark');
    expect(isDark()).toBe(true);
  });

  it('跟随系统:按当前实际亮 / 暗改成相反的固定主题', () => {
    setTheme('system');
    mockSystemDark(false);
    void spec(TOGGLE_LIGHT_DARK_THEMES_COMMAND_ID).fn();
    expect(theme()).toBe('dark');
    setTheme('system');
    mockSystemDark(true);
    void spec(TOGGLE_LIGHT_DARK_THEMES_COMMAND_ID).fn();
    expect(theme()).toBe('light');
  });
});
