# popout 子窗里的面板弹窗与全局热键

背景:dockview-react 经 `ReactDOM.createPortal` 把面板渲染进 popout 子窗 DOM,代码在主窗 JS 环境执行,
全局 `document` 恒为主窗。子窗的按键 / 焦点事件只在子窗 document 上派发,挂在主窗 document 的监听收不到。
子窗本身(`?popout=1`)只渲染 PopoutHost,不注册任何热键。

## 行为契约

### 面板内弹窗(design `Modal`,ConfirmDialog / 插件确认框等都基于它)

- Modal 的 Esc 关闭、Tab / Shift+Tab 焦点陷阱、关闭后焦点还原,都作用于 **Modal 内容所在文档**:
  挂在子窗时在子窗按 Esc 关闭、Tab 不跳出;主窗按 Esc 不影响子窗里的 Modal。
- 关闭后焦点回到打开前子窗里的焦点元素。

### 改键录制(KeybindingCaptureModal,由可弹出的 Settings 面板渲染)

- 在弹窗所在文档(capture 阶段)录制按键:Settings 弹出到子窗后,在子窗按组合键能录到。

### 全局热键只认主窗(命令热键 `useCommandHotkeys`、⌘P / ⌘⇧P `usePickerToggleHotkey`)

- 只挂主窗 `document`,在 popout 子窗按下不响应:命令 / picker 的效果都画在主窗(新终端、设置面板、Quick Open),
  从子窗触发时系统焦点留在子窗(renderer 无激活主窗的通路),接着输入的字会进子窗的编辑器 / 终端;picker 的 Modal
  在子窗里也 Esc 关不掉。面板内的弹窗与改键录制(见上)按所在文档处理,在子窗照常。

## 不在本主题验证

- 真实 Electron popout 窗口里的键盘手感。

- tablist 方向键轮转(`handleTablistArrowKeys`,TabNav / Tabs 共用)按 tablist 所在文档的焦点计算;dock tab 条
  (SharedTab)键盘切换后在 tab 所在文档里查找目标 tab 聚焦 —— 面板弹出到子窗后方向键切 tab 与焦点跟随照常。

