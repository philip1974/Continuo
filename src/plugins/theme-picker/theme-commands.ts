// 首选项:颜色主题 / 在浅色和深色主题之间切换(VSCode workbench.action.selectTheme / toggleLightDarkThemes)。
// - 颜色主题:VSCode 默认键 ⌘K ⌘T 是和弦,键位模型不支持和弦 → 不给默认键(命令面板 / 快捷键页可自行绑定)。打开 Quick Pick
//   列出 亮色 / 暗色 / 高对比度深色 / 高对比度浅色 / 跟随系统,初始选中当前项,上下移动即预览,Enter 写设置,Esc 恢复(见 ThemePickerModal)。
// - 切换浅深:亮 ↔ 暗,高对比度深 ↔ 高对比度浅(VSCode 同)。VSCode 在「跟随系统配色」开着时拒绝切换并提示;Continuo 的「跟随系统」
//   是主题设置的一个值,切换即按当前实际亮 / 暗改成相反的固定主题(与在设置页点另一项相同)。
// 两者都只改本窗口界面 / 设置值,popout 子窗里也经热键分发(选择器画在按键所在子窗)。
// BDD: src/__tests__/theme-commands/

import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { useSettingsValuesStore } from '@/plugins/settings/values-store';
import { GENERAL_THEME } from '@/plugins/settings/core-setting-specs';
import {
  currentThemeMode,
  resolveThemeMode,
  THEME_MODES,
  type ColorScheme,
  type ThemeMode,
} from '@/theme/ThemeProvider';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import { useOpenRecentStore } from '@/plugins/open-recent/store';
import { useThemePickerStore } from './store';

export const SELECT_THEME_COMMAND_ID = 'workbench.action.selectTheme';
export const TOGGLE_LIGHT_DARK_THEMES_COMMAND_ID = 'workbench.action.toggleLightDarkThemes';

/** 打开颜色主题选择器(与其它选择器互斥),选中行落在当前主题。 */
export function openThemePicker(): void {
  useQuickOpenStore.getState().close();
  useCommandPaletteStore.getState().close();
  useOpenRecentStore.getState().close();
  const store = useThemePickerStore;
  store.getState().open();
  store.setState({ selectedIndex: Math.max(0, THEME_MODES.indexOf(currentThemeMode())) });
}

// VSCode toggleLightDarkThemes:LIGHT → 暗,DARK → 亮,HIGH_CONTRAST_LIGHT → 高对比度深,HIGH_CONTRAST_DARK → 高对比度浅。
const TOGGLED: Record<ColorScheme, ThemeMode> = { light: 'dark', dark: 'light', hcLight: 'hcDark', hcDark: 'hcLight' };

/** 在浅色和深色主题之间切换:按当前实际生效的主题写入相反明暗的固定主题(高对比度保持高对比度)。 */
export function toggleLightDarkThemes(): void {
  const next = TOGGLED[resolveThemeMode(currentThemeMode())];
  useSettingsValuesStore.getState().setValue(GENERAL_THEME.id, next);
}

export function themeCommandSpecs(): CommandSpec[] {
  return [
    {
      id: SELECT_THEME_COMMAND_ID,
      title: 'Color Theme',
      titleKey: 'commands.preferences.select_theme.title',
      category: 'Preferences',
      categoryKey: 'commands.preferences.category',
      fn: openThemePicker,
    },
    {
      id: TOGGLE_LIGHT_DARK_THEMES_COMMAND_ID,
      title: 'Toggle between Light/Dark Themes',
      titleKey: 'commands.preferences.toggle_light_dark_themes.title',
      category: 'Preferences',
      categoryKey: 'commands.preferences.category',
      fn: toggleLightDarkThemes,
    },
  ];
}
