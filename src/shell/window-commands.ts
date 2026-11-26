// 窗口类命令(VSCode 同名命令):转到文件…(Quick Open)、显示所有命令(命令面板)、关闭窗口、重新加载窗口、放大 / 缩小 / 重置缩放、切换全屏。
// 显示所有命令另有附加默认键 F1(进命令分发)。
// 与应用菜单同一动作:关闭窗口经 coApi.window.close(关窗脏确认),其余经 window:view-action(重新加载走菜单 ⌘R 的
// 脏确认 + flush)。无默认键:按键由应用菜单 accelerator 处理;⌘P / ⇧⌘P 是 Quick Open / 命令面板保留键(picker 监听处理,
// 两条命令只显示该键、不分发,见 PICKER_TOGGLE_COMMAND_IDS)。WindowPlugin 注册。
// BDD: src/__tests__/command-discoverability/、src/__tests__/reserved-command-hotkeys/

import { coApi } from '@/lib/co-api';
import { notifyFailure } from '@/notifications/notify-thrown-error';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { SHOW_COMMANDS_COMMAND } from '@/plugins/picker/use-picker-toggle-hotkey';
import type { WindowViewAction } from '../../electron/shared/window-channels';

async function runViewAction(action: WindowViewAction): Promise<void> {
  const r = await coApi.window.viewAction(action);
  if (!r.ok) notifyFailure(r);
}

const VIEW_ACTION_COMMANDS: readonly {
  readonly id: string;
  readonly action: WindowViewAction;
  readonly title: string;
  readonly titleKey: string;
  readonly window?: true;
}[] = [
  { id: 'workbench.action.reloadWindow', action: 'reload', title: 'Reload Window', titleKey: 'commands.window.reload.title', window: true },
  { id: 'workbench.action.zoomIn', action: 'zoomIn', title: 'Zoom In', titleKey: 'commands.view.zoom_in.title' },
  { id: 'workbench.action.zoomOut', action: 'zoomOut', title: 'Zoom Out', titleKey: 'commands.view.zoom_out.title' },
  { id: 'workbench.action.zoomReset', action: 'resetZoom', title: 'Reset Zoom', titleKey: 'commands.view.zoom_reset.title' },
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
  ];
}
