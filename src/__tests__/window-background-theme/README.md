# 窗口底色跟随主题(主进程 BrowserWindow backgroundColor)

行为契约:**主进程窗口底色(renderer 绘制前 / 缩放与 popout 未绘制区露出的颜色)= 当前主题的画布色(--md-surface)。
renderer 的 ThemeProvider 解析出的主题(light / dark,system 已按 OS 解析)变化时经 `window:notify-theme` 告知 main;
main 记住最近主题,对所有已开窗口 setBackgroundColor,之后新建的主窗 / popout 用它。进程冷启动首个窗口尚无上报,
用默认暗色(= 默认主题)。**

对照 VSCode:主进程按当前主题的 editor 背景色给窗口设 backgroundColor(`ThemeMainService.getBackgroundColor`,
renderer 换主题时经 IPC 存下最新颜色,新窗口使用),避免亮色主题开窗闪深色。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/window-background.ts` | 两主题底色常量(须与 design-tokens.css `--md-surface` 一致,本规范守护) |
| `electron/main/ipc/window.ipc.ts` | `window:notify-theme` handler + `currentWindowBackgroundColor()` |
| `electron/main/index.ts` | 主窗 / popout 的 backgroundColor 取 `currentWindowBackgroundColor()` |
| `electron/preload/index.ts` | `coApi.window.notifyTheme(theme)` |
| `src/theme/WindowBackgroundSync.tsx` | 订阅 ThemeProvider 的 resolved 主题并上报 |
| `src/shell/decor/Splash.tsx` | Spotlight 用 currentColor(text-fg),亮色画布上可见 |

## 规范文件

- `window-background-theme.spec.tsx`

## 关键行为

- 常量:`WINDOW_BACKGROUND_COLORS.dark` = `.dark --md-surface`,`.light` = `:root --md-surface`
- main 默认 dark;收到 `{ theme: 'light' }` → 已开窗口全部 setBackgroundColor(light 底色),之后
  `currentWindowBackgroundColor()` = light 底色;非法入参(非 light/dark、多余字段)拒绝且不改状态
- index.ts 两处 BrowserWindow 都经 `currentWindowBackgroundColor()`,不写字面色值
- renderer:挂载即上报当前 resolved 主题,切换主题再上报;上报失败只 console.warn,不影响渲染
- Splash 的 Spotlight 不写死 `fill="white"`(亮色画布上看不见),用 currentColor + text-fg
