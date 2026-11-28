// 工作台布局显隐(VSCode「查看 › 外观」):状态栏 / 活动栏 / dock 组 tab 栏,以及「最大化编辑器组」命令。
// - workbench.action.toggleStatusbarVisibility(layoutActions ToggleStatusbarVisibilityAction):翻转设置 workbench.statusBar.visible;
// - workbench.action.toggleActivityBarVisibility(sidebarPart):workbench.activityBar.location 在 default ↔ hidden 间切换;
// - workbench.action.showMultipleEditorTabs / hideEditorTabs(layoutActions AbstractSetShowTabsAction):设 workbench.editor.showTabs;
// - workbench.action.toggleMaximizeEditorGroup(editorActions ToggleMaximizeEditorGroupAction):最大化 / 还原活动组(无默认键 ——
//   VSCode 只有和弦 ⌘K ⌘M,本项目不支持和弦)。
// 三个显隐都是设置(VSCode 同:写用户设置 → 跨窗口同步、重启保持)。状态栏 / 活动栏由 StatusBar / IconSidebar 自己读设置;tab 栏经
// WorkbenchLayoutFromSettings 在各窗口(主窗与 popout 子窗各自的 <html>)标 data-editor-show-tabs,dockview.css 据此隐藏。
// BDD: src/__tests__/workbench-layout-visibility/

import { useLayoutEffect } from 'react';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { getStoredSettingValue, useSettingsValuesStore, useSettingValue } from '@/plugins/settings/values-store';
import {
  WORKBENCH_ACTIVITY_BAR_LOCATION,
  WORKBENCH_EDITOR_SHOW_TABS,
  WORKBENCH_STATUS_BAR_VISIBLE,
  type EditorShowTabs,
} from '@/plugins/settings/core-setting-specs';
import { getDockApi } from '@/shell/dock/dock-api-ref';
import { activePanelInDocument } from '@/shell/dock/group-mru';
import { getCommandDocument } from '@/shell/dock/popout-documents';
import { toggleMaximizeGroup } from '@/shell/dock/group-sizes';
import type { SettingItemValue } from '@/plugins/registries/SettingItemRegistry';

export const TOGGLE_STATUS_BAR_COMMAND_ID = 'workbench.action.toggleStatusbarVisibility';
export const TOGGLE_ACTIVITY_BAR_COMMAND_ID = 'workbench.action.toggleActivityBarVisibility';
export const SHOW_MULTIPLE_EDITOR_TABS_COMMAND_ID = 'workbench.action.showMultipleEditorTabs';
export const HIDE_EDITOR_TABS_COMMAND_ID = 'workbench.action.hideEditorTabs';
export const TOGGLE_MAXIMIZE_EDITOR_GROUP_COMMAND_ID = 'workbench.action.toggleMaximizeEditorGroup';

/** <html> 上的 tab 栏标记(值 = workbench.editor.showTabs;multiple 时不标)。 */
export const EDITOR_SHOW_TABS_ATTR = 'data-editor-show-tabs';

/** 写设置;等于默认值时删掉覆盖(设置页不显示「已修改」)。 */
function setLayoutSetting(id: string, value: SettingItemValue, defaultValue: SettingItemValue): void {
  const store = useSettingsValuesStore.getState();
  if (value === defaultValue) store.reset(id);
  else store.setValue(id, value);
}

export function isStatusBarVisible(): boolean {
  return getStoredSettingValue(WORKBENCH_STATUS_BAR_VISIBLE.id) !== false;
}

export function isActivityBarVisible(): boolean {
  return getStoredSettingValue(WORKBENCH_ACTIVITY_BAR_LOCATION.id) !== 'hidden';
}

export function editorShowTabs(): EditorShowTabs {
  return getStoredSettingValue(WORKBENCH_EDITOR_SHOW_TABS.id) === 'none' ? 'none' : 'multiple';
}

export function toggleStatusBarVisibility(): void {
  setLayoutSetting(WORKBENCH_STATUS_BAR_VISIBLE.id, !isStatusBarVisible(), WORKBENCH_STATUS_BAR_VISIBLE.default);
}

export function toggleActivityBarVisibility(): void {
  setLayoutSetting(
    WORKBENCH_ACTIVITY_BAR_LOCATION.id,
    isActivityBarVisible() ? 'hidden' : 'default',
    WORKBENCH_ACTIVITY_BAR_LOCATION.default,
  );
}

export function setEditorShowTabs(mode: EditorShowTabs): void {
  setLayoutSetting(WORKBENCH_EDITOR_SHOW_TABS.id, mode, WORKBENCH_EDITOR_SHOW_TABS.default);
}

/** 最大化 / 还原触发窗口的活动组(组不在主窗网格里 / 网格里只有它一个组 → 无操作,同 tab 右键菜单)。 */
export function toggleMaximizeActiveEditorGroup(): void {
  const api = getDockApi();
  const panel = api && activePanelInDocument(api, getCommandDocument());
  if (!api || !panel) return;
  toggleMaximizeGroup(api, panel.group);
}

export function useStatusBarVisible(): boolean {
  return useSettingValue(WORKBENCH_STATUS_BAR_VISIBLE.id, WORKBENCH_STATUS_BAR_VISIBLE.default);
}

export function useActivityBarVisible(): boolean {
  return useSettingValue(WORKBENCH_ACTIVITY_BAR_LOCATION.id, WORKBENCH_ACTIVITY_BAR_LOCATION.default) !== 'hidden';
}

/** 设置 workbench.editor.showTabs → 本窗口 <html> 的 data-editor-show-tabs(主窗与 popout 子窗各挂一份)。 */
export function WorkbenchLayoutFromSettings(): null {
  const showTabs = useSettingValue(WORKBENCH_EDITOR_SHOW_TABS.id, WORKBENCH_EDITOR_SHOW_TABS.default);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (showTabs === 'none') root.setAttribute(EDITOR_SHOW_TABS_ATTR, 'none');
    else root.removeAttribute(EDITOR_SHOW_TABS_ATTR);
  }, [showTabs]);
  return null;
}

/** 命令 spec(WindowPlugin 注册;分类「查看」,都无默认键 —— VSCode 同)。 */
export function workbenchLayoutCommandSpecs(): CommandSpec[] {
  return [
    {
      id: TOGGLE_STATUS_BAR_COMMAND_ID,
      title: 'Toggle Status Bar Visibility',
      titleKey: 'commands.view.toggle_status_bar.title',
      fn: toggleStatusBarVisibility,
    },
    {
      id: TOGGLE_ACTIVITY_BAR_COMMAND_ID,
      title: 'Toggle Activity Bar Visibility',
      titleKey: 'commands.view.toggle_activity_bar.title',
      fn: toggleActivityBarVisibility,
    },
    {
      id: SHOW_MULTIPLE_EDITOR_TABS_COMMAND_ID,
      title: 'Show Multiple Editor Tabs',
      titleKey: 'commands.view.show_multiple_editor_tabs.title',
      fn: () => setEditorShowTabs('multiple'),
    },
    {
      id: HIDE_EDITOR_TABS_COMMAND_ID,
      title: 'Hide Editor Tabs',
      titleKey: 'commands.view.hide_editor_tabs.title',
      fn: () => setEditorShowTabs('none'),
    },
    {
      id: TOGGLE_MAXIMIZE_EDITOR_GROUP_COMMAND_ID,
      title: 'Toggle Maximize Editor Group',
      titleKey: 'commands.view.toggle_maximize_editor_group.title',
      fn: toggleMaximizeActiveEditorGroup,
    },
  ].map((c) => ({ ...c, category: 'View', categoryKey: 'commands.view.category' }));
}
