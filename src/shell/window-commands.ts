// 窗口类命令(VSCode 同名命令):转到文件…(Quick Open)、关闭窗口、重新加载窗口、放大 / 缩小 / 重置缩放、切换全屏。
// 与应用菜单同一动作:关闭窗口经 coApi.window.close(关窗脏确认),其余经 window:view-action(重新加载走菜单 ⌘R 的
// 脏确认 + flush)。无默认键:按键由应用菜单 accelerator 处理(⌘P 是 Quick Open 保留键)。WindowPlugin 注册。
// BDD: src/__tests__/command-discoverability/

import { coApi } from '@/lib/co-api';
import { notifyFailure } from '@/notifications/notify-thrown-error';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
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
