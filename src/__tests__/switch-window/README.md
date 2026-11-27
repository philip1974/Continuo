# switch-window(切换窗口:workbench.action.switchWindow)

背景(第五十轮审计 B 组问题 3):没有「切换窗口」命令,多个主窗口 / popout 子窗之间只能靠系统切换。

对齐 VSCode `workbench.action.switchWindow`(`src/vs/workbench/electron-browser/actions/windowActions.ts` `SwitchWindowAction`):

- 标题 "Switch Window…"(VSCode `Switch Window...`,项目统一用 `…`),三语;分类 Window;命令面板可见
- 默认键:mac ⌃W;Windows / Linux 无(VSCode `primary: 0`)
- 列表 = 所有窗口:各主窗口按创建顺序,每个主窗之后是它打开的 popout 子窗(VSCode `getWindows({ includeAuxiliaryWindows: true })`,
  辅助窗口归到所属主窗下;这里缩进表示归属)。正在关闭(已隐藏且未最小化)/ 找不到所属主窗的窗口不列
- 行 = 窗口标题;触发它的窗口标「当前窗口」(VSCode `Current Window`);初始选中当前窗口的下一个(当前是最后一个 → 第一个)
- 可输入按标题模糊过滤;↑↓ / Enter / 点击 → 聚焦所选窗口(最小化的先还原);选的是当前窗口 → 只关闭选择器;Esc 关闭
- 占位文字 "Select a window to switch to"(VSCode 同)
- 在 popout 子窗里按 ⌃W → 选择器画在该子窗(同其它选择器,见 popout-picker),「当前窗口」是该子窗
- 不做:VSCode 行尾的「关闭窗口」按钮、quickSwitchWindow(快速导航变体)

## ⌃W 与编辑 / 终端的取舍

- 终端获焦:⌃W 交给 shell(readline 删前一个词)—— VSCode `DEFAULT_COMMANDS_TO_SKIP_SHELL` 不含 switchWindow,终端里不触发;
  这里经 `TERMINAL_KEPT_COMMAND_IDS`(与 ⌃R 打开最近同)
- 代码编辑器 / Markdown 编辑器:CodeMirror 与 ProseMirror 的 mac 键表都没有 ⌃W(macOS 文本框也不绑),按键照常打开选择器,同 VSCode
  (Monaco 也不绑 ⌃W)

## main / IPC

- `electron/main/services/window-switch.service.ts` `listSwitchWindows`:列表纯函数
- `window:list-windows`(`{ popoutName? }`):当前窗口 = 发起方主窗;带 popoutName → 发起方打开的那个子窗
- `window:focus-window`(`{ id }`):只限列表会列出的窗口,否则 `NO_WINDOW`

## 规范

- `switch-window-main.spec.ts`:列表顺序 / 归属 / 过滤正在关闭的窗口、两条 IPC
- `switch-window-picker.spec.tsx`:命令(id / 键 / 三语)、终端里 ⌃W 留给 shell、子窗分发、选择器(当前窗口、初始选中、过滤、聚焦、
  子窗里触发)
- 真机:`tests/e2e/switch-window.spec.ts`
