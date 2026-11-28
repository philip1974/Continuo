// 系统(OS)配色:是否暗色 + 是否高对比度。对齐 VSCode IHostColorSchemeService 的 { dark, highContrast }:
// main 按 Electron nativeTheme 判定(themeMainServiceImpl.getColorScheme,逐平台照抄),'updated' 时广播到全部窗口;
// renderer 在主题设置为「跟随系统」时据此(再并上 forced-colors / prefers-contrast 媒体查询)解析主题。
// 纯函数 + 常量;preload 值导入本文件:不得引入 zod。BDD: src/__tests__/high-contrast-theme/

import type { ResolvedTheme } from './window-background';

export interface HostColorScheme {
  readonly dark: boolean;
  readonly highContrast: boolean;
}

export const HOST_COLOR_SCHEME_CHANNELS = {
  /** renderer → main:当前系统配色。返回 HostColorScheme。 */
  GET: 'window:get-host-color-scheme',
  /** main → renderer:系统配色变化(nativeTheme 'updated'),广播到所有窗口。payload HostColorScheme。 */
  CHANGED: 'window:host-color-scheme-changed',
} as const;

/** nativeTheme 中判定用到的字段(便于注入测试)。 */
export interface NativeThemeColorState {
  readonly shouldUseDarkColors: boolean;
  readonly shouldUseHighContrastColors: boolean;
  readonly shouldUseInvertedColorScheme: boolean;
}

/**
 * VSCode ThemeMainService.getColorScheme():
 * - Windows:高对比度 = shouldUseHighContrastColors,明暗 = shouldUseInvertedColorScheme(高对比度黑为 true)
 * - macOS:「反转颜色」(shouldUseInvertedColorScheme)或「增强对比度」(shouldUseHighContrastColors)都算高对比度,明暗按外观
 * - Linux:shouldUseHighContrastColors → 按暗色
 * - 否则:非高对比度,明暗按 shouldUseDarkColors
 */
export function hostColorSchemeFromNativeTheme(platform: string, nt: NativeThemeColorState): HostColorScheme {
  if (platform === 'win32') {
    if (nt.shouldUseHighContrastColors) return { dark: nt.shouldUseInvertedColorScheme, highContrast: true };
  } else if (platform === 'darwin') {
    if (nt.shouldUseInvertedColorScheme || nt.shouldUseHighContrastColors) {
      return { dark: nt.shouldUseDarkColors, highContrast: true };
    }
  } else if (platform === 'linux') {
    if (nt.shouldUseHighContrastColors) return { dark: true, highContrast: true };
  }
  return { dark: nt.shouldUseDarkColors, highContrast: false };
}

/** 「跟随系统」解析(VSCode getPreferredColorScheme,autoDetectHighContrast 默认开)。 */
export function systemResolvedTheme(host: HostColorScheme): ResolvedTheme {
  if (host.highContrast) return host.dark ? 'hcDark' : 'hcLight';
  return host.dark ? 'dark' : 'light';
}

/** CHANGED 推送 / GET 返回值的 runtime 守卫(preload guardedListener 用)。 */
export function isHostColorScheme(value: unknown): value is HostColorScheme {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { dark?: unknown }).dark === 'boolean' &&
    typeof (value as { highContrast?: unknown }).highContrast === 'boolean'
  );
}
