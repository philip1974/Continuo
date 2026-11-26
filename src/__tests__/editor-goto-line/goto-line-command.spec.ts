// @vitest-environment jsdom
// BDD: editor-goto-line 第 1 / 2 / 5 条 —— 命令注册、执行、⌃G 分发、终端不让出。见同目录 README。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { GOTO_LINE_COMMAND, editorCommandSpecs, openGotoLine } from '@/panels/Editor/editor-commands';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import { winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { terminalYieldedCommandId } from '@/panels/Terminal/terminal-hotkeys';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const ID = 'workbench.action.gotoLine';
const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());

beforeEach(() => {
  useQuickOpenStore.setState({ isOpen: false, query: '', selectedIndex: 0 });
  useCommandPaletteStore.setState({ isOpen: false, query: '', selectedIndex: 0 });
});

describe('命令注册', () => {
  it('id = workbench.action.gotoLine,默认键两平台都是 ctrl+g(mac ⌃G 不是 ⌘G)', () => {
    expect(GOTO_LINE_COMMAND).toEqual({ id: ID, hotkey: 'ctrl+g' });
    for (const platform of ['mac', 'other'] as const) {
      expect(editorCommandSpecs(platform).find((s) => s.id === ID)?.hotkey).toBe('ctrl+g');
    }
  });

  it('核心插件注册,三语标题「转到行/列…」', () => {
    const spec = coApp.commands.get(ID);
    expect(spec?.hotkey).toBe('ctrl+g');
    const k = spec!.titleKey as keyof typeof en;
    expect(en[k]).toBe('Go to Line/Column…');
    expect(zh[k]).toBe('转到行/列…');
    expect(ko[k]).toBeTruthy();
  });
});

describe('执行', () => {
  it('打开 Quick Open 并预填 `:`;命令面板开着则先关掉', () => {
    useCommandPaletteStore.getState().open();
    openGotoLine();
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    expect(useQuickOpenStore.getState()).toMatchObject({ isOpen: true, query: ':', selectedIndex: 0 });
  });

  it('Quick Open 已开着(文件搜索)→ 改为 `:`', () => {
    useQuickOpenStore.getState().open();
    useQuickOpenStore.getState().setQuery('foo');
    openGotoLine();
    expect(useQuickOpenStore.getState()).toMatchObject({ isOpen: true, query: ':' });
  });
});

describe('⌃G 分发', () => {
  it('mac:⌃G 胜出为 gotoLine;⌘G 不是(留给查找下一个)', () => {
    const all = coApp.commands.getAll();
    expect(winningCommandFor(key({ key: 'g', code: 'KeyG', ctrlKey: true }), all, 'mac', {})?.id).toBe(ID);
    expect(winningCommandFor(key({ key: 'g', code: 'KeyG', metaKey: true }), all, 'mac', {})?.id).toBeUndefined();
  });

  it('Windows / Linux:Ctrl+G 胜出为 gotoLine', () => {
    expect(winningCommandFor(key({ key: 'g', code: 'KeyG', ctrlKey: true }), coApp.commands.getAll(), 'other', {})?.id).toBe(ID);
  });

  it('改绑后跟随(用户把 gotoLine 改到 mod+l → ⌃G 不再触发)', () => {
    const all = coApp.commands.getAll();
    const overrides = { [ID]: 'mod+l' };
    expect(winningCommandFor(key({ key: 'g', code: 'KeyG', ctrlKey: true }), all, 'mac', overrides)?.id).toBeUndefined();
    expect(winningCommandFor(key({ key: 'l', code: 'KeyL', metaKey: true }), all, 'mac', overrides)?.id).toBe(ID);
  });

  it('终端里 ⌃G 不让出,照常进 shell(两平台)', () => {
    for (const platform of ['mac', 'other'] as const) {
      expect(terminalYieldedCommandId(key({ key: 'g', code: 'KeyG', ctrlKey: true }), platform, {}, coApp.commands)).toBeNull();
    }
  });
});
