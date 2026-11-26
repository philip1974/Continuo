// @vitest-environment jsdom
// BDD: app-menu-bar 第 4 / 5 条 —— 「首选项:打开键盘快捷方式」打开设置并切到快捷键页、焦点落到该页搜索框(设置已打开时切页,
// 不关闭);查找 / 替换命令登记。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { useSettingsStore } from '@/plugins/settings/store';
import { KeybindingsTabContent } from '@/plugins/settings/KeybindingsTabContent';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const ID = 'workbench.action.openGlobalKeybindings';

function fakePanel(isActive: boolean) {
  const panel = {
    id: 'settings',
    api: { id: 'settings', isActive, setActive: vi.fn(), close: vi.fn(), location: { type: 'grid' }, group: { panels: [] as unknown[] } },
    view: { content: { element: document.createElement('div') } },
  };
  panel.api.group.panels.push(panel);
  return panel;
}

beforeEach(async () => {
  await shutdownCorePlugins();
  bootCorePlugins();
  setDockApi(null);
  useLayoutUiStore.setState({ sidebarOpen: true });
  useSettingsStore.setState({ activeTabId: 'core.general', tabSearchFocusRequested: false });
});

afterEach(async () => {
  cleanup();
  await shutdownCorePlugins();
  setDockApi(null);
});

describe('命令登记', () => {
  it('id / 分类 / 标题对齐 VSCode「Preferences: Open Keyboard Shortcuts」,三语齐全;无默认键(VSCode ⌘K ⌘S 为和弦)', () => {
    const cmd = coApp.commands.get(ID)!;
    expect(cmd).toMatchObject({ title: 'Open Keyboard Shortcuts', category: 'Preferences' });
    expect(cmd.hotkey).toBeUndefined();
    expect(cmd.secondaryHotkeys).toBeUndefined();
    expect([en, zh, ko].map((l) => l['commands.preferences.category'])).toEqual(['Preferences', '首选项', '기본 설정']);
    expect([en, zh, ko].map((l) => l[cmd.titleKey as keyof typeof en])).toEqual([
      'Open Keyboard Shortcuts',
      '打开键盘快捷方式',
      '바로 가기 키 열기',
    ]);
  });
});

describe('执行', () => {
  it('设置未打开 → 新建设置面板、切到快捷键页、收起侧栏', async () => {
    const api = { getPanel: vi.fn(() => undefined), addPanel: vi.fn(() => fakePanel(true)) };
    setDockApi(api as never);
    await coApp.commands.execute(ID);
    expect(api.addPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'settings', component: 'settings' }));
    expect(useSettingsStore.getState().activeTabId).toBe('core.keybindings');
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);
  });

  it('设置已打开且正显示(别的页)→ 不关闭,切到快捷键页', async () => {
    const panel = fakePanel(true);
    const api = { getPanel: vi.fn(() => panel), addPanel: vi.fn(), activePanel: panel };
    setDockApi(api as never);
    await coApp.commands.execute(ID);
    expect(panel.api.close).not.toHaveBeenCalled();
    expect(api.addPanel).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().activeTabId).toBe('core.keybindings');
  });

  it('焦点落到快捷键页的搜索框;请求只用一次(之后切走再切回不抢焦点)', async () => {
    setDockApi({ getPanel: vi.fn(() => undefined), addPanel: vi.fn(() => fakePanel(true)) } as never);
    await coApp.commands.execute(ID);
    const view = render(<KeybindingsTabContent />);
    const search = screen.getByRole('textbox');
    expect(document.activeElement).toBe(search);
    expect(useSettingsStore.getState().tabSearchFocusRequested).toBe(false);

    search.blur();
    view.unmount();
    render(<KeybindingsTabContent />);
    expect(document.activeElement).toBe(document.body);
  });

  it('快捷键页已显示时执行 → 焦点回到其搜索框', async () => {
    setDockApi({ getPanel: vi.fn(() => undefined), addPanel: vi.fn(() => fakePanel(true)) } as never);
    render(<KeybindingsTabContent />);
    const search = screen.getByRole('textbox');
    search.blur();
    await act(async () => {
      await coApp.commands.execute(ID);
    });
    expect(document.activeElement).toBe(search);
  });
});

describe('查找 / 替换命令(编辑 → 查找 / 替换)', () => {
  it('actions.find ⌘F、startFindReplaceAction(jsdom 平台为 Windows / Linux → Ctrl+H),限定编辑器正文;三语标题', () => {
    expect(coApp.commands.get('actions.find')).toMatchObject({ title: 'Find', hotkey: 'mod+f', when: 'editorTextFocus' });
    expect(coApp.commands.get('editor.action.startFindReplaceAction')).toMatchObject({
      title: 'Replace',
      hotkey: 'ctrl+h',
      when: 'editorTextFocus',
    });
    expect([en, zh, ko].map((l) => l['commands.editor.text.find.title'])).toEqual(['Find', '查找', '찾기']);
    expect([en, zh, ko].map((l) => l['commands.editor.text.replace.title'])).toEqual(['Replace', '替换', '바꾸기']);
  });
});
