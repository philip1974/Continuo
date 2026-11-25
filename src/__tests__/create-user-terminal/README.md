# create-user-terminal(新建 user terminal 共用流程)

可维护性 M1:命令面板 `terminal.new`(`core-plugins/TerminalPlugin`)与
Dock header「新建终端」入口(`shell/dock/HeaderActions`)曾各自复制同一段创建流程
(等 hydrate → 读 workspace root → `coApi.terminal.create` → 错误提示 → `setPendingFocus`),
HeaderActions 注释也明写「同 TerminalPlugin.terminal.new」=平行实现易漂移。

抽到 `src/shell/dock/create-user-terminal.ts` 单一来源,入口只调 `createUserTerminal(opts?)`(命令面板 / Dock header
新建、Explorer「在终端中打开」传 `{ cwd: 所选目录, env }`),各自负责 UI 收尾(HeaderActions 自己 `setOpen(false)`)。行为保持。

## 行为契约 — `createUserTerminal(opts: { cwd?, env? } = {}): Promise<string | null>`

- 先 `await waitForWorkspaceRootRestored()`(冷启动竞态:root=null → TERMINAL_CWD_UNRESOLVED,R10;只需 root 已恢复,不等编辑器 tab 恢复读盘,见 `startup-critical-path`)
- 读 `useWorkspaceStore.getState().root` 作 workspaceRoot;`cwd = opts.cwd ?? workspaceRoot` →
  `create({ originHint:'user', cwd?, workspaceRoot?, env? })`(各字段有值才带;root 与 opts.cwd 都为空 → 不带 cwd/workspaceRoot)
- 无工作区(未传 cwd 的 CWD_UNRESOLVED)→ 不是错误:直接调起已注册的「打开文件夹」命令(`workbench.action.files.openFolder`)
  并**等它完成**(`runRegisteredCommand` 返回命令完成的 Promise),保留用户「新建终端」的意图(VSCode 心智:缺前置条件给下一步,
  完成后接着做原来的事):
  - 选定文件夹(root 已有值)→ 在新 root 重新走本流程新建终端并聚焦,返回新 id;不弹任何提示
  - 取消对话框(root 仍空)→ 不建终端,`notify.info`「请先打开一个文件夹」(三语),返回 `null`
  - notify 不支持撤掉(dismiss),故不在弹对话框前先提示(否则选定后提示一直挂着)。Continuo 刻意不回退主目录
- 其余失败 → `notify.error`(CWD_UNRESOLVED 且传了 cwd(root 已被外部删除 / 外置盘断开 / 「在终端中打开」已删目录)时提示「目录不存在或不可访问:{path}」;否则带 code)+ 返回 `null`,不 focus
- `TERMINAL_CREATE_CANCELLED`(用户关 tab 取消 / 退出闸拒绝)→ 无论 `{ok:false}` 还是 reject 都静默返回 `null`,不 notify
- 成功有 id → `setPendingFocus(id)` + 返回 id;成功无 id → 返回 `null`,不 focus

> 端到端:命令面板路径见 `49-polish-bugfixes/terminal-new-waits-hydration`,
> 双入口失败反馈见 `window-workspace-roots-map/renderer-fail-feedback`。
