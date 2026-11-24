// 主进程窗口底色(BrowserWindow backgroundColor:renderer 绘制前 / 缩放与 popout 未绘制区露出的颜色)。
// 值 = 两主题的画布色(src/styles/design-tokens.css 的 --md-surface);electron/ 不能 import src/,故写字面值,
// 由 src/__tests__/window-background-theme/ 守护与 token 一致(改画布色时提醒同步)。
// 纯常量,main / preload / renderer 都可 import。

export type ResolvedTheme = 'light' | 'dark';

export const WINDOW_BACKGROUND_COLORS: Readonly<Record<ResolvedTheme, string>> = {
  light: '#fffbff',
  dark: '#11131b',
};
