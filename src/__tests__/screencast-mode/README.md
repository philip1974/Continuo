# 屏幕录制模式(VSCode「开发人员: 切换屏幕录制模式」)

行为契约:**命令面板执行「开发者: 切换屏幕录制模式」后,窗口底部浮出最近按下的组合键(快捷键页同一格式)与它分发到的命令名
(当前界面语言),最后一次按键约 0.8 秒后淡出;鼠标按下处显示圆圈。再次执行即关闭。开关只在内存里(重新加载 / 重启后关闭)。
密码 / 敏感输入框里的按键不显示。主窗与 popout 子窗都生效。**

## 对照 VSCode

- `src/vs/workbench/browser/actions/developerActions.ts` `ToggleScreencastModeAction`:`workbench.action.toggleScreencastMode`,
  分类 Developer,`f1: true`,无默认键;开关是静态 disposable(不持久化)。
  - 键盘:`keydown` 捕获(所有窗口);组字中 / 单独修饰键不显示;带修饰键、Backspace、Esc、方向键或已满 20 条时先清空;
    `softDispatch` 命中命令 → 先显示命令标题(`showCommands` 默认开,`showCommandGroups` 默认关 = 不带分类),再显示键位;普通字符键
    也显示(`showKeys` 默认开);最后一次按键 `keyboardOverlayTimeout`(默认 800,500..5000)后清空。
  - 鼠标:`mousedown` 在按下点显示圆圈,按住移动跟随,`mouseup` 隐藏。
  - 设置 `screencastMode.fontSize`(56,20..100)、`verticalOffset`(20%,0..90)、`keyboardOverlayTimeout`、`mouseIndicatorColor`
    (#FF0000)、`mouseIndicatorSize`(20)、`keyboardOptions`。
- `src/vs/workbench/browser/actions/media/actions.css`:整宽横条居中、溢出省略、`pointer-events: none`;仅开启动效时 `opacity 0.3s`
  过渡。

**刻意差异**:设置只取 `fontSize` / `verticalOffset` / `keyboardOverlayTimeout`(极简);颜色走主题 token(含高对比度,强制颜色下用
系统色),鼠标圆圈固定 20px、用错误色;**焦点在密码 / 敏感输入里(`type=password`、`autocomplete` 为密码 / 一次性验证码、带
`data-screencast-sensitive`,如插件「从 Git URL 安装」的地址框 —— 地址里可能带令牌)的按键不显示**(VSCode 照常显示);输入法
组字内容不显示(VSCode 显示组字);超时后先淡出、下一次按键再清空(VSCode 立即清空文字、底色淡出)。授权弹窗没有文本输入,不另处理。
⌘P / ⇧⌘P 是 picker 保留键,命令名取其归属命令(转到文件… / 显示所有命令)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/screencast/screencast-store.ts` | 开关 / 条目 / 鼠标状态,`recordScreencastPress`(清空规则、超时淡出),命令 spec |
| `src/shell/screencast/screencast-keys.ts` | 一次 keydown → 键位 + 命令名(或不显示) |
| `src/shell/screencast/ScreencastOverlay.tsx` | 懒加载浮层:各窗口捕获监听,portal 进按键 / 按下所在窗口 |
| `src/shell/screencast/ScreencastHost.tsx` | 开启时才加载浮层(MainApp 挂载) |
| `src/shell/screencast/screencast.css` | 样式(token、减弱动效无过渡、强制颜色) |

## 规范文件

- `screencast-mode.spec.tsx`

## 关键行为

1. 命令 `workbench.action.toggleScreencastMode`:分类「开发者」,三语标题,无默认键;WindowPlugin 注册;再次执行关闭并清空。
2. 键位 + 命令名:⌘P → 「转到文件… ⌘P」;绑定的命令 → 标题 + 键位;普通字符 → 只有键位;单独修饰键 / 组字中 → 不显示。
3. 敏感输入:`type=password`、`autocomplete=current-password|new-password|one-time-code`、`[data-screencast-sensitive]` 内的按键不显示。
4. 累积:普通字符累积;带修饰键 / Backspace / Esc / 方向键先清空;超时后淡出(`data-visible=false`),之后的按键从空开始;关闭时不记录。
5. 浮层:`aria-hidden`、不接收指针;字号 / 距底随设置;鼠标按下显示圆圈(以按下点为圆心)、松开消失;popout 子窗里的按键画在子窗。
6. 减弱动效:`prefers-reduced-motion: reduce` 时无过渡。

## e2e

`tests/e2e/presentation-mode.spec.ts`:开启 → ⌘P → 底部显示「转到文件… ⌘P」→ 淡出;鼠标圆圈;关闭后不再显示。
