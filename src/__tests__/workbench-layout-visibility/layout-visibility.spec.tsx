// @vitest-environment jsdom
// BDD: workbench-layout-visibility —— 状态栏 / 活动栏 / 标签栏显隐设置与命令、最大化编辑器组命令、切换全屏默认键。见同目录 README 1–6。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { _resetLmApiForTest, captureLmApi } from '@/lib/co-api';
import { setLocale } from '@/i18n';
import { coApp } from '@/plugins/co-app';
import {
  WORKBENCH_ACTIVITY_BAR_LOCATION,
  WORKBENCH_EDITOR_SHOW_TABS,
  WORKBENCH_STATUS_BAR_VISIBLE,
} from '@/plugins/settings/core-setting-specs';
import { getStoredSettingValue, useSettingsValuesStore } from '@/plugins/settings/values-store';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { isPopoutHotkeyCommand, winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { terminalYieldedCommandId } from '@/panels/Terminal/terminal-hotkeys';
import {
  EDITOR_SHOW_TABS_ATTR,
  WorkbenchLayoutFromSettings,
  workbenchLayoutCommandSpecs,
} from '@/shell/workbench-layout';
import { toggleFullScreenHotkey, windowCommandSpecs } from '@/shell/window-commands';
import { StatusBar } from '@/shell/StatusBar';
import { IconSidebar } from '@/shell/IconSidebar';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useEditorStore } from '@/stores/editor.store';
import { EditorHeader } from '@/panels/Editor/EditorHeader';
import { useWorkspaceTrustStore } from '@/stores/workspace-trust.store';
import { createDock } from '../dock-terminal-vscode-focus/dock-fixtures';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

const specs = workbenchLayoutCommandSpecs();
const run = (id: string) => specs.find((c) => c.id === id)!.fn();
const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const fileTab = (id: string) => ({ id, filePath: id, content: 'x', originalContent: 'x', dirty: false });
const SETTINGS = [WORKBENCH_STATUS_BAR_VISIBLE, WORKBENCH_ACTIVITY_BAR_LOCATION, WORKBENCH_EDITOR_SHOW_TABS];

beforeAll(() => {
  for (const s of SETTINGS) if (!coApp.settingItems.get(s.id)) coApp.settingItems.register(s);
});
beforeEach(() => {
  setLocale('en');
  useSettingsValuesStore.setState({ values: {} });
  _resetLmApiForTest();
  Object.defineProperty(window, 'api', { value: {}, writable: true, configurable: true });
  captureLmApi();
  useWorkspaceStore.setState({ root: '/w', recentRoots: [] });
  useWorkspaceTrustStore.setState({ state: null });
});
afterEach(() => {
  cleanup();
  setDockApi(null);
  delete (window as { api?: unknown }).api;
  document.documentElement.removeAttribute(EDITOR_SHOW_TABS_ATTR);
});

describe('设置项', () => {
  it('VSCode 同 id;默认显示 / default / multiple;三语文案;通用 / 编辑器 tab 注册', () => {
    expect(WORKBENCH_STATUS_BAR_VISIBLE).toMatchObject({ id: 'workbench.statusBar.visible', default: true, category: 'general' });
    expect(WORKBENCH_ACTIVITY_BAR_LOCATION).toMatchObject({ id: 'workbench.activityBar.location', default: 'default' });
    expect(WORKBENCH_ACTIVITY_BAR_LOCATION.enum!.map((e) => e.value)).toEqual(['default', 'hidden']);
    expect(WORKBENCH_EDITOR_SHOW_TABS).toMatchObject({ id: 'workbench.editor.showTabs', default: 'multiple', category: 'editor' });
    expect(WORKBENCH_EDITOR_SHOW_TABS.enum!.map((e) => e.value)).toEqual(['multiple', 'none']);
    for (const s of SETTINGS) {
      for (const cat of [en, zh, ko] as Array<Record<string, string>>) {
        expect(cat[s.titleKey!], s.id).toEqual(expect.any(String));
        expect(cat[s.descriptionKey!], s.id).toEqual(expect.any(String));
      }
    }
    expect(src('src/core-plugins/GeneralTabPlugin.ts')).toContain('this.addSettingItem(WORKBENCH_STATUS_BAR_VISIBLE)');
    expect(src('src/core-plugins/GeneralTabPlugin.ts')).toContain('this.addSettingItem(WORKBENCH_ACTIVITY_BAR_LOCATION)');
    expect(src('src/core-plugins/EditorTabPlugin.ts')).toContain('this.addSettingItem(WORKBENCH_EDITOR_SHOW_TABS)');
  });
});

describe('命令', () => {
  it('分类「查看」,无默认键,三语标题;WindowPlugin 注册', () => {
    expect(specs.map((c) => c.id)).toEqual([
      'workbench.action.toggleStatusbarVisibility',
      'workbench.action.toggleActivityBarVisibility',
      'workbench.action.showMultipleEditorTabs',
      'workbench.action.hideEditorTabs',
      'workbench.action.toggleMaximizeEditorGroup',
    ]);
    for (const c of specs) {
      expect(c.categoryKey, c.id).toBe('commands.view.category');
      expect(c.hotkey, c.id).toBeUndefined();
      for (const cat of [en, zh, ko] as Array<Record<string, string>>) expect(cat[c.titleKey!], c.id).toEqual(expect.any(String));
    }
    expect(src('src/core-plugins/WindowPlugin.ts')).toContain('workbenchLayoutCommandSpecs()');
  });

  it('切换写设置;回到默认值时删掉覆盖', () => {
    run('workbench.action.toggleStatusbarVisibility');
    expect(getStoredSettingValue(WORKBENCH_STATUS_BAR_VISIBLE.id)).toBe(false);
    run('workbench.action.toggleStatusbarVisibility');
    expect(getStoredSettingValue(WORKBENCH_STATUS_BAR_VISIBLE.id)).toBeUndefined();
    run('workbench.action.toggleActivityBarVisibility');
    expect(getStoredSettingValue(WORKBENCH_ACTIVITY_BAR_LOCATION.id)).toBe('hidden');
    run('workbench.action.toggleActivityBarVisibility');
    expect(getStoredSettingValue(WORKBENCH_ACTIVITY_BAR_LOCATION.id)).toBeUndefined();
    run('workbench.action.hideEditorTabs');
    expect(getStoredSettingValue(WORKBENCH_EDITOR_SHOW_TABS.id)).toBe('none');
    run('workbench.action.showMultipleEditorTabs');
    expect(getStoredSettingValue(WORKBENCH_EDITOR_SHOW_TABS.id)).toBeUndefined();
  });
});

describe('状态栏 / 活动栏', () => {
  const setStatusBar = (v: boolean) => act(() => useSettingsValuesStore.getState().setValue(WORKBENCH_STATUS_BAR_VISIBLE.id, v));

  it('状态栏隐藏 → 不渲染(F6 区域随之跳过)', () => {
    const { container } = render(<StatusBar />);
    expect(container.querySelector('footer[data-statusbar]')).not.toBeNull();
    setStatusBar(false);
    expect(container.querySelector('footer')).toBeNull();
  });

  it('隐藏期间受限模式仍在一条精简状态栏里(安全指示与出口),信任后精简状态栏也消失', () => {
    act(() => useWorkspaceTrustStore.setState({ state: { root: '/w', trusted: false } }));
    const { container } = render(<StatusBar />);
    setStatusBar(false);
    const footer = container.querySelector('footer[data-statusbar-minimal]');
    expect(footer).not.toBeNull();
    expect(footer!.getAttribute('data-workbench-part')).toBe('statusbar');
    expect(footer!.querySelector('[data-restricted-mode]')).not.toBeNull();
    // 只含安全指示:没有 MCP 复制等普通项
    expect(footer!.querySelectorAll('button')).toHaveLength(1);
    act(() => useWorkspaceTrustStore.setState({ state: { root: '/w', trusted: true } }));
    expect(container.querySelector('footer')).toBeNull();
  });

  it('活动栏隐藏 → 不渲染', () => {
    const { container } = render(<IconSidebar />);
    expect(container.querySelector('aside')).not.toBeNull();
    act(() => useSettingsValuesStore.getState().setValue(WORKBENCH_ACTIVITY_BAR_LOCATION.id, 'hidden'));
    expect(container.querySelector('aside')).toBeNull();
  });
});

describe('标签栏', () => {
  it('隐藏 → 本窗口 <html data-editor-show-tabs="none">,恢复即移除;App(主窗与 popout 子窗)挂载', () => {
    render(<WorkbenchLayoutFromSettings />);
    expect(document.documentElement.hasAttribute(EDITOR_SHOW_TABS_ATTR)).toBe(false);
    act(() => run('workbench.action.hideEditorTabs'));
    expect(document.documentElement.getAttribute(EDITOR_SHOW_TABS_ATTR)).toBe('none');
    act(() => run('workbench.action.showMultipleEditorTabs'));
    expect(document.documentElement.hasAttribute(EDITOR_SHOW_TABS_ATTR)).toBe(false);
    const app = src('src/shell/App.tsx');
    expect(app.indexOf('<WorkbenchLayoutFromSettings />')).toBeLessThan(app.indexOf('isPopoutWindow() ? <PopoutHost />'));
  });

  it('隐藏 → 编辑器文件 tab 行(连同编辑器操作)不渲染,恢复即回来(VSCode showTabs none = NoEditorTabsControl)', () => {
    useEditorStore.setState({ tabs: [fileTab('/w/a.ts'), fileTab('/w/b.ts')], activeTabId: '/w/a.ts', mode: 'source' });
    const { container } = render(<EditorHeader onCloseRequest={() => {}} />);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    act(() => run('workbench.action.hideEditorTabs'));
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.firstChild).toBeNull();
    act(() => run('workbench.action.showMultipleEditorTabs'));
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });

  it('dock 组 tab 栏只在组里仅有一个编辑器面板时随之隐藏;与终端等面板同组 / 只有终端时照常显示(鼠标仍可切换面板)', () => {
    const css = src('src/styles/dockview.css');
    // 旧规则(所有 dock 组都藏 tab 栏)不得回来
    expect(css).not.toMatch(/:root\[data-editor-show-tabs='none'\] \.dv-groupview > \.dv-tabs-and-actions-container \{/);
    const rule = /:root\[data-editor-show-tabs='none'\]\s+\.dv-groupview:has\(([^{]+)\{\s*display: none !important;/.exec(css);
    expect(rule).not.toBeNull();
    const selector = `.dv-groupview:has(${rule![1]!}`.trim();
    const dom = (panels: ('editor' | 'terminal')[]) => {
      const group = document.createElement('div');
      group.className = 'dv-groupview';
      group.innerHTML =
        `<div class="dv-tabs-and-actions-container"><div class="dv-tabs-container">${panels.map(() => '<div class="dv-tab"></div>').join('')}</div></div>` +
        `<div class="dv-content-container">${panels[0] === 'editor' ? '<div data-editor-panel-root=""></div>' : '<div data-panel-focus-root=""></div>'}</div>`;
      document.body.appendChild(group);
      const header = group.querySelector('.dv-tabs-and-actions-container')!;
      const hidden = header.matches(selector);
      group.remove();
      return hidden;
    };
    expect(dom(['editor'])).toBe(true);
    expect(dom(['editor', 'terminal'])).toBe(false);
    expect(dom(['terminal', 'editor'])).toBe(false);
    expect(dom(['terminal'])).toBe(false);
  });
});

describe('最大化编辑器组', () => {
  function twoGroups(): DockviewApi {
    const dock = createDock();
    setDockApi(dock.api);
    dock.api.addPanel({ id: 'a', component: 'editor', title: 'A' });
    dock.api.addPanel({ id: 'b', component: 'editor', title: 'B', position: { referencePanel: 'a', direction: 'right' } });
    return dock.api;
  }

  it('多组时最大化活动组,再执行还原', () => {
    const api = twoGroups();
    api.getPanel('b')!.api.setActive();
    run('workbench.action.toggleMaximizeEditorGroup');
    expect(api.getPanel('b')!.group.api.isMaximized()).toBe(true);
    run('workbench.action.toggleMaximizeEditorGroup');
    expect(api.hasMaximizedGroup()).toBe(false);
  });

  it('只有一个组 → 无操作;没有 dock → 无操作', () => {
    run('workbench.action.toggleMaximizeEditorGroup');
    const dock = createDock();
    setDockApi(dock.api);
    dock.api.addPanel({ id: 'a', component: 'editor', title: 'A' });
    run('workbench.action.toggleMaximizeEditorGroup');
    expect(dock.api.hasMaximizedGroup()).toBe(false);
  });
});

describe('切换全屏默认键', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, ...init });
  const fullScreen = (): CommandSpec => windowCommandSpecs().find((c) => c.id === 'workbench.action.toggleFullScreen')!;

  it('mac ⌃⌘F、Windows / Linux F11(VSCode 同)', () => {
    expect(toggleFullScreenHotkey('mac')).toBe('ctrl+mod+f');
    expect(toggleFullScreenHotkey('other')).toBe('f11');
    expect(fullScreen().hotkey).toBe(toggleFullScreenHotkey());
    expect(winningCommandFor(key({ key: 'f', code: 'KeyF', metaKey: true, ctrlKey: true }), [{ ...fullScreen(), hotkey: 'ctrl+mod+f' }], 'mac', {})?.id).toBe(
      'workbench.action.toggleFullScreen',
    );
  });

  it('popout 子窗里也分发(只让该子窗全屏);终端获焦时让出(VSCode commandsToSkipShell)', () => {
    expect(isPopoutHotkeyCommand(fullScreen())).toBe(true);
    const registry = { getAll: () => [{ ...fullScreen(), hotkey: 'f11' }] };
    expect(terminalYieldedCommandId(key({ key: 'F11', code: 'F11' }), 'other', {}, registry)).toBe('workbench.action.toggleFullScreen');
  });
});
