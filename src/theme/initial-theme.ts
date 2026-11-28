// renderer 首帧主题:入口模块(main.tsx)在动态加载样式与 React(main-app)之前同步调用,按设置值 general.theme
// 给 <html> 定好主题 class(dark / hc-black / hc-light)。index.html 静态写的是 class="dark"(默认主题),亮色用户若等 ThemeProvider 挂载后的
// effect 才去掉,样式先到的那一帧会画成深色。CSP(script-src 'self')不允许 index.html 内联脚本,入口模块是
// 最早能执行的同源脚本。之后由 ThemeProvider 接管(同一设置值,结果一致)。
// 只依赖无运行时依赖的模块,保持入口 chunk 轻量。设置值的权威存储在 main,首帧经同步 IPC 快照拿到(见 user-settings-initial)。
// BDD: src/__tests__/window-background-theme/
import { GENERAL_THEME } from '@/plugins/settings/core-setting-specs';
import { SETTINGS_VALUES_STORAGE_KEY } from '@/plugins/settings/storage-key';
import { ownValue } from '../../electron/shared/own-value';
import { initialUserSettingsRecord } from '@/plugins/storage/user-settings-initial';
import {
  THEME_MODE_VALUES,
  isDarkTheme,
  type ResolvedTheme,
  type ThemeModeValue,
} from '../../electron/shared/window-background';
import { systemResolvedTheme } from '../../electron/shared/host-color-scheme';

function storedThemeMode(): unknown {
  // 与 values-store 初值同一来源:main 的同步快照(已迁移)或旧 localStorage 记录(需要迁移 / 无 main)。
  return ownValue(initialUserSettingsRecord('settings', SETTINGS_VALUES_STORAGE_KEY), GENERAL_THEME.id);
}

function mediaMatches(query: string): boolean | null {
  try {
    const mql = globalThis.matchMedia?.(query);
    return mql === undefined ? null : mql.matches;
  } catch {
    return null;
  }
}

// 首帧拿不到 main 的 nativeTheme 判定(异步 IPC):只按媒体查询;macOS「反转颜色」等由 ThemeProvider 挂载后补上。
function systemTheme(): ResolvedTheme {
  return systemResolvedTheme({
    dark: mediaMatches('(prefers-color-scheme: dark)') !== false,
    highContrast: mediaMatches('(forced-colors: active)') === true || mediaMatches('(prefers-contrast: more)') === true,
  });
}

/** 按设置值解析首帧主题(system 跟随 prefers-color-scheme 与系统高对比度;无效 / 缺失 → 默认主题)。 */
export function readInitialTheme(): ResolvedTheme {
  const stored = storedThemeMode();
  const mode = (THEME_MODE_VALUES as readonly unknown[]).includes(stored)
    ? (stored as ThemeModeValue)
    : GENERAL_THEME.default;
  return mode === 'system' ? systemTheme() : mode;
}

/** 同 ThemeProvider.applyThemeClass(不 import 它:入口 chunk 不带 React / zustand)。 */
export function applyInitialThemeClass(): void {
  const cl = globalThis.document?.documentElement.classList;
  if (!cl) return;
  const theme = readInitialTheme();
  cl.toggle('dark', isDarkTheme(theme));
  cl.toggle('hc-black', theme === 'hcDark');
  cl.toggle('hc-light', theme === 'hcLight');
}
