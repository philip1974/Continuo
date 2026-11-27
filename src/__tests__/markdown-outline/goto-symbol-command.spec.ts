// @vitest-environment jsdom
// BDD: markdown-outline 第 2 条 —— 转到符号命令(⇧⌘O)、大纲聚焦命令:注册、三语、执行、分发、popout、菜单。见同目录 README。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { GOTO_SYMBOL_COMMAND, editorCommandSpecs, openGotoSymbol } from '@/panels/Editor/editor-commands';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import { isPopoutHotkeyCommand, winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { isMenuCommandId } from '../../../electron/shared/window-channels';
import { FOCUS_OUTLINE_COMMAND_ID, focusOutlineView } from '@/panels/Outline/outline-commands';
import { __resetOutlineStoreForTest, useOutlineStore } from '@/panels/Outline/outline-store';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const ID = 'workbench.action.gotoSymbol';
const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());

beforeEach(() => {
  useQuickOpenStore.setState({ isOpen: false, query: '', selectedIndex: 0 });
  useCommandPaletteStore.setState({ isOpen: false, query: '', selectedIndex: 0 });
  __resetOutlineStoreForTest();
});

describe('转到符号命令', () => {
  it('id = workbench.action.gotoSymbol,默认键 mod+shift+o(两平台)', () => {
    expect(GOTO_SYMBOL_COMMAND).toEqual({ id: ID, hotkey: 'mod+shift+o' });
    for (const platform of ['mac', 'other'] as const) {
      expect(editorCommandSpecs(platform).find((s) => s.id === ID)?.hotkey).toBe('mod+shift+o');
    }
  });

  it('核心插件注册,三语标题;菜单「转到」里有它', () => {
    const spec = coApp.commands.get(ID);
    expect(spec?.hotkey).toBe('mod+shift+o');
    const k = spec!.titleKey as keyof typeof en;
    expect(en[k]).toBe('Go to Symbol in Editor…');
    expect(zh[k]).toBe('转到编辑器中的符号…');
    expect(ko[k]).toBe('편집기에서 기호로 이동…');
    expect(isMenuCommandId(ID)).toBe(true);
    expect(zh['menu.go.go_to_symbol']).toBe('转到编辑器中的符号…');
  });

  it('执行 → Quick Open 预填 `@`;命令面板开着则关掉;已开着的文件搜索改为 `@`', () => {
    useCommandPaletteStore.getState().open();
    openGotoSymbol();
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    expect(useQuickOpenStore.getState()).toMatchObject({ isOpen: true, query: '@', selectedIndex: 0 });
    useQuickOpenStore.getState().setQuery('foo');
    openGotoSymbol();
    expect(useQuickOpenStore.getState().query).toBe('@');
  });

  it('⇧⌘O(mac)/ Ctrl+Shift+O(其它)胜出为 gotoSymbol;改绑后跟随', () => {
    const all = coApp.commands.getAll();
    expect(winningCommandFor(key({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true }), all, 'mac', {})?.id).toBe(ID);
    expect(winningCommandFor(key({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true }), all, 'other', {})?.id).toBe(ID);
    const overrides = { [ID]: 'mod+alt+o' };
    expect(winningCommandFor(key({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true }), all, 'mac', overrides)?.id).toBeUndefined();
  });

  it('popout 子窗里分发(选择器画在按键所在子窗)', () => {
    expect(isPopoutHotkeyCommand({ id: ID })).toBe(true);
  });
});

describe('聚焦到大纲视图', () => {
  it('注册(资源管理器分类,无默认键,三语);执行 → 显示侧栏、展开大纲并请求聚焦', () => {
    const spec = coApp.commands.get(FOCUS_OUTLINE_COMMAND_ID);
    expect(spec?.hotkey).toBeUndefined();
    expect(spec?.categoryKey).toBe('commands.explorer.category');
    const k = spec!.titleKey as keyof typeof en;
    expect([en[k], zh[k], ko[k]]).toEqual(['Focus on Outline View', '聚焦到大纲视图', '개요 보기에 포커스']);
    useLayoutUiStore.getState().setSidebarOpen(false);
    focusOutlineView();
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
    expect(useOutlineStore.getState()).toMatchObject({ expanded: true, focusRequest: 1 });
  });
});
