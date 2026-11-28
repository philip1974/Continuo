# 拆分终端

对齐 VSCode `workbench.action.terminal.split`「拆分终端」(`terminalActions.ts` 的 `TerminalCommandId.Split`,菜单
`terminalMenus.ts`:「终端」菜单 Create 组第 2 项、终端右键菜单 Create 组)。此前拆分终端没有任何入口:终端获焦时 ⌘\ 拆分的是
编辑器,终端菜单只有「新建终端 / 切换终端」,右键菜单只有复制 / 粘贴 / 全选 / 清除,命令面板搜不到。

Continuo 的终端是 dock 面板(1 PTY = 1 面板),「窗格」= 窗口里显示终端的 dock 组(见 `terminal-focus-cycle`)。拆分 = 在父终端
旁新建一个终端:

1. **命令**:`workbench.action.terminal.split`,三语标题「拆分终端 / Split Terminal / 터미널 분할」,类别「终端」,命令面板可搜,
   快捷键页可改键。默认键同 VSCode:mac ⌘\(附加 ⌃⇧5),Windows / Linux Ctrl+Shift+5。
2. **按键只在终端获焦时生效**(`when: terminalFocus`):终端里 ⌘\ 拆分终端(压过同键的「拆分编辑器」),编辑器等其它地方 ⌘\
   照常拆分编辑器,两者不算冲突。终端里胜出即让出、不发给 shell(VSCode commandsToSkipShell 默认含 Split);Windows / Linux
   的 Ctrl+\ 仍进 shell(SIGQUIT)。
3. **父终端**:焦点所在的终端 → 触发窗口的活动终端 → 该窗口最近使用的终端(同 `terminal-focus-cycle` 7);右键菜单拆分被右键的
   那个终端。窗口里没有终端 → 新建终端(刻意差异:VSCode 此时 no-op、菜单项按 terminalIsOpen 置灰;本项目菜单不置灰)。
4. **落点**:父终端在主窗 grid → 在父终端所在组**右侧**拆出新组(不是追加到最后一个终端右边);右侧放不下(分屏会让组窄于
   `MIN_TERMINAL_SPLIT_WIDTH`)→ 加进父终端的组(同新建终端的最小宽度约束)。父终端在 popout 子窗 / 浮动组 → 加进父终端的组,
   **留在该窗口**(dockview 的 popout 窗口只有一个组,不能再分)。session 推送早于或晚于 create 的 RPC 返回都一样;期间出现的
   agent 终端不占用这个落点。
5. **cwd**:同 VSCode `terminal.integrated.splitCwd` 默认 `inherited` —— 父终端的当前目录,由 main 端 `terminal.cwd` 给出
   (只查本窗口的会话):shell 用 OSC 7 上报过 → 上报的目录;否则(macOS 默认 zsh 不注入 OSC 7)→ shell 进程的真实当前目录
   (VSCode `terminalProcess.ts` getCwd:macOS `lsof`(这里 execFile `/usr/sbin/lsof -a -d cwd -p <pid> -Fn`,2s 超时)、Linux
   `/proc/<pid>/cwd`,须是存在的绝对目录);再取不到(Windows / lsof 失败 / 目录已删)→ 其初始目录(VSCode 回退 initialCwd);
   IPC 失败 → 会话 cwd;都没有 → 工作区根(同新建终端)。查询期间父终端被关 → 按不存在处理。
6. **焦点进入新终端**(同新建终端:pendingFocus 激活其面板)。右键菜单拆分失败(新建被拒 / 无工作区时取消选文件夹)→ 焦点还给
   父终端,不掉到 body;失败前焦点已去了别处则不抢(`terminal-vscode-parity/context-menu.spec.tsx`)。
7. **入口**:「终端」菜单「新建终端」之后的「拆分终端」(显示键位);终端右键菜单首项「拆分终端」(显示键位),与复制等编辑项
   之间有分隔线;命令面板。

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/terminal-split.ts` | 父终端、cwd、调起 `createUserTerminal` 并登记落点 |
| `electron/main/ipc/terminal.ipc.ts` | `terminal:cwd`(`makeCwdHandler`)、OSC 7 上报记号(`makeUpdateCwdHandler`) |
| `electron/main/services/terminal-process-cwd.ts` | 读进程真实当前目录 |
| `src/shell/dock/DockReconciler.ts` | `expectSplitTerminal`:新终端认领落点(右侧新组 / 父终端的组) |
| `src/panels/Terminal/terminal-hotkeys.ts` | 命令 id、默认键、终端让出 |
| `src/core-plugins/TerminalPlugin.ts` | 命令注册 |
| `src/panels/Terminal/TerminalContextMenu.tsx` | 右键菜单项 |
| `electron/main/app-menu.ts` | 「终端」菜单项 |

## 规范文件

- `terminal-split.spec.ts` — 1–7
- `split-cwd-main.spec.ts` — 5(main 端 `terminal.cwd`:OSC 7 优先 / 进程目录 / 回退 / 本窗口限定)
- `process-cwd.spec.ts` — 5(读进程当前目录:mac lsof / Linux /proc / Windows null / 失败回退)
