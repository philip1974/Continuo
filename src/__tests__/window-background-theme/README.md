# 窗口底色跟随主题(主进程 BrowserWindow backgroundColor)

行为契约:**主进程窗口底色(renderer 绘制前 / 缩放与 popout 未绘制区露出的颜色)= 当前主题的画布色(--md-surface)。
renderer 的 ThemeProvider 解析出的主题(light / dark,system 已按 OS 解析)变化时经 `window:notify-theme` 告知 main;
main 记住最近主题,对所有已开窗口 setBackgroundColor,之后新建的主窗 / popout 用它;并持久化到 userData,进程冷启动的
首个窗口用上次主题(从未上报过 = 默认暗色)。renderer 首帧在样式与 React 加载前就按设置值定好 `<html>` 的 dark class。**

对照 VSCode:主进程按当前主题的 editor 背景色给窗口设 backgroundColor(`ThemeMainService.getBackgroundColor`,
renderer 换主题时经 IPC 存下最新颜色,新窗口使用),避免亮色主题开窗闪深色。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/window-background.ts` | 两主题底色常量(须与 design-tokens.css `--md-surface` 一致,本规范守护) |
| `electron/main/ipc/window.ipc.ts` | `window:notify-theme` handler + `currentWindowBackgroundColor()` |
| `electron/main/services/window-theme.service.ts` | 主题内存态 + `userData/window-theme.json` 持久化(`loadWindowTheme` / `setWindowTheme` / `getWindowTheme`) |
| `src/theme/initial-theme.ts` | renderer 首帧按设置值 `general.theme`(system → prefers-color-scheme)同步设 `<html>` dark class |
| `src/main.tsx` | 入口:先 `applyInitialThemeClass()`,再动态 import main-app |
| `electron/main/index.ts` | 主窗 / popout 的 backgroundColor 取 `currentWindowBackgroundColor()` |
| `electron/preload/index.ts` | `coApi.window.notifyTheme(theme, mode?)` |
| `src/theme/WindowBackgroundSync.tsx` | 订阅 ThemeProvider 的 resolved 主题并上报 |
| `src/shell/decor/Splash.tsx` | Spotlight 用 currentColor(text-fg),亮色画布上可见 |

## 规范文件

- `window-background-theme.spec.tsx`
- `window-theme-persist.spec.ts`(冷启动:持久化读写、system 模式、损坏回退、启动接线)
- `initial-theme.spec.ts`(renderer 首帧 class)

## 关键行为

- 常量:`WINDOW_BACKGROUND_COLORS.dark` = `.dark --md-surface`,`.light` = `:root --md-surface`
- main 默认 dark;收到 `{ theme: 'light' }` → 已开窗口全部 setBackgroundColor(light 底色),之后
  `currentWindowBackgroundColor()` = light 底色;非法入参(非 light/dark、多余字段)拒绝且不改状态
- index.ts 两处 BrowserWindow 都经 `currentWindowBackgroundColor()`,不写字面色值
- renderer:挂载即上报当前 resolved 主题,切换主题再上报;上报失败只 console.warn,不影响渲染
- Splash 的 Spotlight 不写死 `fill="white"`(亮色画布上看不见),用 currentColor + text-fg

## 冷启动(亮色用户首窗不闪深色)

对照 VSCode `ThemeMainService`:主题变化时把背景色存进 storage,下次开窗直接用。

- main:`window:notify-theme` 入参 `{ theme, mode? }`(mode ∈ light / dark / system,strict),收到即更新内存并串行原子写
  `userData/window-theme.json`(独立小文件,不进 `settings.json`——后者是 `{version, locale}` 严格 schema,加字段会让旧版本
  把新文件当损坏隔离)。启动时 `loadWindowTheme()` 与 `loadSettings()` 同批 await,先于首个 `createMainWindow`。
- 冷启动底色:持久化 `mode=system` → 按 `nativeTheme.shouldUseDarkColors`(OS 当前外观,不用上次解析值);否则用持久化的
  `theme`。文件缺失 / JSON 损坏 / 字段非法 / 超大(> 4 KiB)→ 默认暗色,不抛。
- renderer:`index.html` 静态 `class="dark"`;CSP `script-src 'self'` 不允许内联脚本,故由入口模块 `main.tsx` 在动态加载
  main-app(样式 + React)之前同步 `applyInitialThemeClass()`:读 localStorage 设置值 `general.theme`(与 values-store 同键
  `SETTINGS_VALUES_STORAGE_KEY`,只认自有键),system 按 `prefers-color-scheme`,无效 / 缺失 / 存储不可用 → 默认主题。
  样式到达时 class 已正确,之后 ThemeProvider 用同一设置值接管。
- WindowBackgroundSync 上报 `(resolved, mode)`。
