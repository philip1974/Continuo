# 终端读屏支持(screenReaderMode + 输入框可访问名)

行为契约:**检测到系统读屏(或设置强制开启)时,终端输出进 xterm 的可访问 DOM 树(`.xterm-accessibility`)供读屏朗读;
终端输入框的读屏名称随界面语言本地化并带终端序号 / 标题。**

## 对照 VSCode(已核实源码)

- 没有 `terminal.integrated.screenReaderMode` 设置;终端 `xterm.options.screenReaderMode = accessibilityService.isScreenReaderOptimized()`
  (terminalInstance.updateAccessibilitySupport,`editor.accessibilitySupport` 变化时重算)。
- `isScreenReaderOptimized()` = `editor.accessibilitySupport === 'on' || ('auto' && 平台检测到辅助技术)`,设置取值 auto / on / off,默认 auto。
- 平台检测:main 建窗时把 `app.isAccessibilitySupportEnabled()` 放进窗口配置;`app.on('accessibility-support-changed')` 时
  `sendToAll('vscode:accessibilitySupportChanged')`,renderer `setAccessibilitySupport` 后各终端即时更新。
- 终端输入框 aria-label:`Terminal {id}, {title}`(无标题时 `Terminal {id}`),本地化。

## 行为

1. 设置项 `editor.accessibilitySupport`(通用页,auto / on / off,默认 auto)。
2. 判定:on → 开;off → 关;auto → 跟随系统检测。
3. main 提供 `accessibility:get-support`(返回 `app.isAccessibilitySupportEnabled()`),系统状态变化时向所有窗口(含 popout)广播
   `accessibility:support-changed`(`{ enabled }`;preload 丢弃畸形 payload)。renderer 首次需要时拉初值,变化推送先到则初值作废。
4. 终端创建时带上当前判定;判定变化(改设置 / 系统读屏开关)→ 所有已开终端即时改 `screenReaderMode`,不重建。关闭时不建可访问树,无额外开销。
5. 输入框可访问名:有默认序号 →「Terminal N, 标题」/「终端 N,标题」/「터미널 N, 标题」(标题即「终端 N」本身时只读「终端 N」);
   无序号 →「Terminal, 标题」。xterm 在 open 时写内置英文「Terminal input」,open 之后即覆盖;改名 / 切换语言即时同步。

## 不做

- ⌥F2 可访问视图(accessible view)与「切换读屏辅助模式」命令:成本高,暂不做。

## 规范

- `screen-reader-mode.spec.tsx`:判定表、创建时带判定、设置 / 系统推送变化同步到所有已开终端、初值与推送竞态。
- `accessibility-main.spec.ts`:main 初值通道与变化广播;推送 payload 守卫。
- `terminal-input-aria-label.spec.tsx`:三语可访问名、open 后覆盖、变化同步。
- e2e `tests/e2e/terminal-screen-reader.spec.ts`:设置强制 on 后 `.xterm-accessibility` 出现并含输出;输入框名本地化。
