// renderer 首帧主题:入口模块(main.tsx)在动态加载样式与 React(main-app)之前同步调用,按设置值 general.theme
// 给 <html> 定好主题 class(dark / hc-black / hc-light)。index.html 静态写的是 class="dark"(默认主题),亮色用户若等 ThemeProvider 挂载后的
// effect 才去掉,样式先到的那一帧会画成深色。CSP(script-src 'self')不允许 index.html 内联脚本,入口模块是
// 最早能执行的同源脚本。之后由 ThemeProvider 接管(同一设置值,结果一致)。
// 只依赖无运行时依赖的模块,保持入口 chunk 轻量。BDD: src/__tests__/window-background-theme/
import { GENERAL_THEME } from '@/plugins/settings/core-setting-specs';
import { SETTINGS_VALUES_STORAGE_KEY } from '@/plugins/settings/storage-key';
import { ownValue } from '../../electron/shared/own-value';
import {
  THEME_MODE_VALUES,
  isDarkTheme,
  type ResolvedTheme,
  type ThemeModeValue,
} from '../../electron/shared/window-background';
import { systemResolvedTheme } from '../../electron/shared/host-color-scheme';

// 与 values-store 读端同一原始串上限(1 MiB):超限视为无记录,不在启动关键路径上解析超大 JSON。
const MAX_RAW_LENGTH = 1024 * 1024;

function storedThemeMode(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_VALUES_STORAGE_KEY);
    if (!raw || raw.length > MAX_RAW_LENGTH) return undefined;
    const record: unknown = JSON.parse(raw);
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
    return ownValue(record as Record<string, unknown>, GENERAL_THEME.id);
  } catch {
    return undefined; // localStorage 被禁用 / JSON 损坏:按默认主题
  }
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
