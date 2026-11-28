# window-crash-recovery(主窗渲染进程崩溃 / 无响应的提示与恢复)

参考 VSCode `CodeWindow.onWindowError`(`src/vs/platform/windows/electron-main/windowImpl.ts`)。实现:`electron/main/window-error-dialogs.ts`,
`electron/main/index.ts` 的 `createMainWindow` 挂接。

## 渲染进程崩溃(`render-process-gone`,`window-error-dialogs.spec.ts`)

- reason ≠ `clean-exit` → 在该窗口上弹原生警告框:标题「窗口意外终止(原因:「<reason>」,代码:「<exitCode>」)」,
  说明「可以重新打开窗口,从上次停止的位置继续」,按钮「重新打开」「关闭」
- 崩溃前该窗口有未保存的 tab → 框里另列出这些文件名(最多 10 个,其余一行概括),说明这些文件未保存的更改已丢失(只提示,不做热退出)
- 同一次崩溃只弹一次:框开着时再来的 `render-process-gone` 不叠框;popout 子窗自己的崩溃事件不弹(子窗与主窗同进程,由主窗弹)
- 「重新打开」→ 先销毁该窗口打开的 popout 子窗(含子窗再弹出的),再 reload(面板由主窗布局恢复);
  「关闭」→ 同样先销毁 popout,再关窗(不再弹「是否保存」)
- `clean-exit`、应用退出中、该窗口正在关闭(关窗 flush 在途)、窗口已销毁 → 不弹

## 窗口无响应(`unresponsive`)

- 弹「窗口没有响应」+「重新打开」「关闭」「保持等待」(Esc = 保持等待)
- 弹框时该窗口有未保存的 tab → 说明里另列出这些文件名(最多 10 个,其余一行概括),明确「重新打开或关闭窗口将丢失以下文件未保存的更改」,
  默认按钮改为「保持等待」(VSCode 有热退出备份,说明固定、默认「重新打开」;这里没有备份,刻意差异)
- 恢复响应(`responsive`)→ 关掉仍开着的框(AbortSignal),不做任何处理
- 「重新打开」/「关闭」→ `forcefullyCrashRenderer()`,记下选择;等杀进程引发的 `render-process-gone` 到达(不弹崩溃框)后
  才销毁 popout → reload / 关窗(同 tick reload 会被退出中的旧进程吞掉,窗口停在崩溃空白态);
  3 秒内没等到该事件 → 超时照样恢复,且只恢复一次;之后真正的崩溃照常弹崩溃框
- 「保持等待」→ 什么都不做;同一段无响应期间不重复弹框;开着 DevTools 时不弹(断点停住也会报无响应)

## 端到端(`tests/e2e/window-crash-recovery.spec.ts`)

- 改脏 a.ts → `forcefullyCrashRenderer()` → 崩溃框列出 a.ts;选「重新打开」→ 窗口重新加载并恢复工作区
- 主窗 emit `unresponsive` → 弹无响应框;emit `responsive` → 框被关掉,窗口不受影响
- 改脏 a.ts 后主窗 emit `unresponsive` → 无响应框列出 a.ts 并说明重新打开 / 关闭会丢失
- 主窗 emit `unresponsive` → 选「重新打开」→ 窗口不再是崩溃态且工作区树恢复;选「关闭」→ 主窗关掉
- 终端在窄宽度下产生带光标上移的输出、窗口变宽后崩溃 → 重新打开后回放结果与崩溃前一致(见 `terminal-replay-dimensions`)
- 调试适配器被杀的端到端见 `tests/e2e/debug-user-controls.spec.ts`(`debug-adapter-crash`)
