# 原生对话框挂在发起窗口上

行为契约:**应用内弹出的原生对话框(选择文件夹、另存为、确认框)模态于发起它的窗口** —— macOS 上是挂在该窗口上的 sheet,
多显示器时出现在用户正在操作的那块屏 / 那个窗口上,不会落到别的屏或其它窗口后面。对齐 VSCode
`src/vs/platform/dialogs/electron-main/dialogMainService.ts`:`showOpenDialog(options, window || BrowserWindow.getFocusedWindow())`,
`showMessageBox` / `showSaveDialog` 同样以发起窗口(缺省获焦窗口)为父;都没有 → 独立对话框。

## 行为

- **「打开文件夹」(renderer 发起,`fs:selectDirectory`)**:挂在发送方主窗上;在该主窗的 popout 子窗里操作(子窗获焦)→
  挂子窗(同另存为 `fs:showSaveDialog` 的 `parentFor`)。发送方不是主窗 → 获焦窗口;也没有 → 独立对话框。
- **菜单「在新窗口打开文件夹…」(⌘O / Dock 菜单)**:挂在获焦窗口上;没有窗口(macOS 关光窗口后)→ 独立对话框。
- 两个入口仍共用「记住上次所选位置」(`createRememberingOpenDialog`):父窗口参数原样透传,不影响 defaultPath 记忆。
- 其余原生对话框已按发起窗口挂(核实):另存为(`fs/save-dialog.ts`)、关窗「是否保存」、崩溃 / 无响应提示(所属窗口)、
  外链确认 / 关于 / 工作区信任(传入窗口,已销毁 / 没有 → 独立)、开窗失败提示(获焦窗口)。启动时的 MCP 旧配置提示补上
  获焦窗口兜底(启动早期没有窗口 → 独立)。

## 规范

- `dialog-parent-window.spec.ts`
