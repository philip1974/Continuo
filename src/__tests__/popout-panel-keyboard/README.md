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

### 全局热键(命令热键 `useCommandHotkeys`、⌘P / ⌘⇧P `usePickerToggleHotkey`)

- 监听挂在「所有应用文档」上 = 主窗 document + 当前 dockview popout 子窗的 document(`src/lib/app-documents.ts`)。
- popout 子窗打开(组位置变为 `popout`)即加入,子窗关闭 / 组回到主窗 / 组被移除即移出
  (`src/shell/dock/popout-documents.ts` 跟踪 dockview 组位置,DockShell onReady 时挂上)。
- 同一按键只触发一次:一个按键事件只在其所在文档派发;同一文档重复登记只挂一个监听。

## 不在本主题验证

- 真实 Electron popout 窗口里的键盘手感;⌘P / ⌘⇧P 打开的面板仍渲染在主窗(子窗按下后需切到主窗操作)。
