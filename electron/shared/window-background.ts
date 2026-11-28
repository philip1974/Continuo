// 主进程窗口底色(BrowserWindow backgroundColor:renderer 绘制前 / 缩放与 popout 未绘制区露出的颜色)。
// 值 = 各主题的画布色(src/styles/design-tokens.css 的 --md-surface);electron/ 不能 import src/,故写字面值,
// 由 src/__tests__/window-background-theme/ 与 high-contrast-theme/ 守护与 token 一致(改画布色时提醒同步)。
// 纯常量,main / preload / renderer 都可 import。

/** 解析后的主题(= VSCode ColorScheme:dark / light / hcDark / hcLight)。 */
export type ResolvedTheme = 'light' | 'dark' | 'hcDark' | 'hcLight';

/** 主题设置值 general.theme 的全集(颜色主题选择器 / 设置页的列表顺序;system 跟随 OS,含系统高对比度)。 */
export const THEME_MODE_VALUES = ['light', 'dark', 'hcDark', 'hcLight', 'system'] as const;
export type ThemeModeValue = (typeof THEME_MODE_VALUES)[number];

export const RESOLVED_THEME_VALUES = ['light', 'dark', 'hcDark', 'hcLight'] as const satisfies readonly ResolvedTheme[];

/** 暗色系(VSCode isDark:DARK / HIGH_CONTRAST_DARK)。 */
export function isDarkTheme(theme: ResolvedTheme): boolean {
  return theme === 'dark' || theme === 'hcDark';
}

/** 高对比度(VSCode isHighContrast)。 */
export function isHighContrastTheme(theme: ResolvedTheme): boolean {
  return theme === 'hcDark' || theme === 'hcLight';
}

export const WINDOW_BACKGROUND_COLORS: Readonly<Record<ResolvedTheme, string>> = {
  light: '#fffbff',
  dark: '#11131b',
  hcDark: '#000000',
  hcLight: '#ffffff',
};
