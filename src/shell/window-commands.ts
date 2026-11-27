// 窗口类命令(VSCode 同名命令):转到文件…(Quick Open)、显示所有命令(命令面板)、关闭窗口、重新加载窗口、放大 / 缩小 / 重置缩放、切换全屏。
// 显示所有命令另有附加默认键 F1(进命令分发)。
// 与应用菜单同一动作:关闭窗口经 coApi.window.close(关窗脏确认),重新加载 / 切换全屏经 window:view-action(重新加载走菜单
// ⌘R 的脏确认 + flush),按键由应用菜单 accelerator 处理;⌘P / ⇧⌘P 是 Quick Open / 命令面板保留键(picker 监听处理,
// 两条命令只显示该键、不分发,见 PICKER_TOGGLE_COMMAND_IDS)。
// 放大 / 缩小 / 重置缩放(VSCode windowActions ZoomIn / ZoomOut / ZoomReset,window.zoomPerWindow=false 语义):改设置项
// window.zoomLevel(所有窗口统一,ZoomLevelFromSettings 推给 main),默认键同 VSCode(⌘= / ⌘- 及 ⇧ / 小键盘附加键;重置另留 ⌘0)。
// WindowPlugin 注册。
// BDD: src/__tests__/command-discoverability/、src/__tests__/reserved-command-hotkeys/、src/__tests__/window-zoom/

import { coApi } from '@/lib/co-api';
import { notifyFailure } from '@/notifications/notify-thrown-error';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { SHOW_COMMANDS_COMMAND } from '@/plugins/picker/use-picker-toggle-hotkey';
import { getStoredSettingValue, useSettingsValuesStore } from '@/plugins/settings/values-store';
import { WINDOW_ZOOM_LEVEL } from '@/plugins/settings/core-setting-specs';
import type { WindowViewAction } from '../../electron/shared/window-channels';
import { clampZoomLevel, MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL } from '../../electron/shared/window-zoom';

async function runViewAction(action: WindowViewAction): Promise<void> {
  const r = await coApi.window.viewAction(action);
  if (!r.ok) notifyFailure(r);
}

function currentZoomLevel(): number {
  const stored = getStoredSettingValue(WINDOW_ZOOM_LEVEL.id);
  return typeof stored === 'number' ? clampZoomLevel(stored) : WINDOW_ZOOM_LEVEL.default;
}

/**
 * VSCode BaseZoomAction.setZoomLevel:放大 / 缩小 = 当前级别 ±1 后取整(消掉小数级别),越过 [-8, 8] 不动;重置 = 回到默认 0
 *(删掉设置覆盖,设置页同「恢复默认」)。
 */
export function stepZoomLevel(delta: 1 | -1): void {
  const level = Math.round(currentZoomLevel() + delta);
  if (level > MAX_ZOOM_LEVEL || level < MIN_ZOOM_LEVEL) return;
  useSettingsValuesStore.getState().setValue(WINDOW_ZOOM_LEVEL.id, level);
}

export function resetZoomLevel(): void {
  useSettingsValuesStore.getState().reset(WINDOW_ZOOM_LEVEL.id);
}

const ZOOM_COMMANDS: readonly CommandSpec[] = [
  {
    id: 'workbench.action.zoomIn',
    title: 'Zoom In',
    titleKey: 'commands.view.zoom_in.title',
    hotkey: 'mod+=',
    secondaryHotkeys: ['mod+shift+=', 'mod+numpad_add'],
    fn: () => stepZoomLevel(1),
  },
  {
    id: 'workbench.action.zoomOut',
    title: 'Zoom Out',
    titleKey: 'commands.view.zoom_out.title',
    hotkey: 'mod+-',
    secondaryHotkeys: ['mod+shift+-', 'mod+numpad_subtract'],
    fn: () => stepZoomLevel(-1),
  },
  {
    id: 'workbench.action.zoomReset',
    title: 'Reset Zoom',
    titleKey: 'commands.view.zoom_reset.title',
    // VSCode 只绑 ⌘Numpad0;另留 ⌘0(此前菜单 role resetZoom 的键、无小键盘的笔记本可用)作主键显示。
    hotkey: 'mod+0',
    secondaryHotkeys: ['mod+numpad0'],
    fn: resetZoomLevel,
  },
].map((c) => ({ ...c, category: 'View', categoryKey: 'commands.view.category' }));

const VIEW_ACTION_COMMANDS: readonly {
  readonly id: string;
  readonly action: WindowViewAction;
  readonly title: string;
  readonly titleKey: string;
  readonly window?: true;
}[] = [
  { id: 'workbench.action.reloadWindow', action: 'reload', title: 'Reload Window', titleKey: 'commands.window.reload.title', window: true },
  {
    id: 'workbench.action.toggleFullScreen',
    action: 'toggleFullScreen',
    title: 'Toggle Full Screen',
    titleKey: 'commands.view.toggle_full_screen.title',
  },
];

export function windowCommandSpecs(): CommandSpec[] {
  return [
    {
      id: 'workbench.action.quickOpen',
      title: 'Go to File…',
      titleKey: 'commands.quick_open.title',
      fn: () => useQuickOpenStore.getState().open(),
    },
    {
      id: 'workbench.action.showCommands',
      title: 'Show All Commands',
      titleKey: 'commands.show_commands.title',
      // 附加默认键 F1(VSCode 同,各平台):进命令分发;⇧⌘P 仍由 picker 监听处理(保留键,显示用它)。
      secondaryHotkeys: SHOW_COMMANDS_COMMAND.secondaryHotkeys,
      // 与 ⇧⌘P 同语义:两个 picker 互斥,打开命令面板前关掉 Quick Open。
      fn: () => {
        useQuickOpenStore.getState().close();
        useCommandPaletteStore.getState().open();
      },
    },
    {
      id: 'workbench.action.closeWindow',
      title: 'Close Window',
      titleKey: 'commands.window.close.title',
      category: 'Window',
      categoryKey: 'commands.window.category',
      fn: async () => {
        const r = await coApi.window.close();
        if (!r.ok) notifyFailure(r);
      },
    },
    ...VIEW_ACTION_COMMANDS.map(
      (c): CommandSpec => ({
        id: c.id,
        title: c.title,
        titleKey: c.titleKey,
        ...(c.window
          ? { category: 'Window', categoryKey: 'commands.window.category' }
          : { category: 'View', categoryKey: 'commands.view.category' }),
        fn: () => runViewAction(c.action),
      }),
    ),
    ...ZOOM_COMMANDS,
  ];
}
