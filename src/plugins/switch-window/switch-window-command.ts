// 切换窗口(VSCode workbench.action.switchWindow,标题 "Switch Window..."):默认键 mac ⌃W,Windows / Linux 无(VSCode primary: 0)。
// 终端获焦时 ⌃W 留给 shell(删前一个词;VSCode commandsToSkipShell 默认列表不含本命令,见 terminal-hotkeys TERMINAL_KEPT_COMMAND_IDS);
// 编辑器里(CodeMirror / Milkdown 的 mac 键表都没有 ⌃W)照常打开选择器,同 VSCode(Monaco 也不绑 ⌃W)。
// popout 子窗里也分发(选择器画在按键所在子窗,当前窗口 = 该子窗)。BDD: src/__tests__/switch-window/

import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { detectPlatform, type Platform } from '@/plugins/command-palette/format-hotkey';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import { useOpenRecentStore } from '@/plugins/open-recent/store';
import { useThemePickerStore } from '@/plugins/theme-picker/store';
import { useSwitchWindowStore } from './store';

export const SWITCH_WINDOW_COMMAND_ID = 'workbench.action.switchWindow';

/** 打开切换窗口选择器(与其它选择器互斥)。 */
export function openSwitchWindowPicker(): void {
  useQuickOpenStore.getState().close();
  useCommandPaletteStore.getState().close();
  useOpenRecentStore.getState().close();
  useThemePickerStore.getState().close();
  useSwitchWindowStore.getState().show();
}

export function switchWindowCommandSpec(platform: Platform = detectPlatform()): CommandSpec {
  return {
    id: SWITCH_WINDOW_COMMAND_ID,
    title: 'Switch Window…',
    titleKey: 'commands.window.switch.title',
    category: 'Window',
    categoryKey: 'commands.window.category',
    ...(platform === 'mac' ? { hotkey: 'ctrl+w' } : {}),
    fn: openSwitchWindowPicker,
  };
}
