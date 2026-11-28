# Windows / Linux 用户视角对齐 VSCode

第六十轮 B 组审计(Windows / Linux 用户视角)发现的平台差异。参考 VSCode 源码(github.com/microsoft/vscode)与
vscode-loc 中文 / 韩文语言包。mac 上无法实机跑 Windows / Linux:规范用 vitest 桩 `navigator.platform`(`Win32` /
`Linux x86_64` / `MacIntel`)覆盖,mac 行为不变。

## 行为

1. **终端复制 / 粘贴键**(VSCode `terminal.clipboard.contribution.ts` 的 CopySelection / CopyAndClearSelection / Paste,同 id、
   同标题、三语;都在 `DEFAULT_COMMANDS_TO_SKIP_SHELL` 里 → 胜出即让出,按键不交给 shell):
   - `workbench.action.terminal.copySelection` 复制所选内容:Windows / Linux **Ctrl+Shift+C**;
   - `workbench.action.terminal.copyAndClearSelection` 复制并清除选区:Windows **Ctrl+C**;
   - 两个复制命令 when = `terminalTextSelectedFocus`(终端获焦且有选区,VSCode `terminalTextSelected && terminalFocus`):
     没有选区时不胜出 → Windows 的 Ctrl+C 照常发 `^C` 给 shell;
   - `workbench.action.terminal.paste` 粘贴到活动终端:Windows **Ctrl+V**(附加 Ctrl+Shift+V)、Linux **Ctrl+Shift+V**
     (when 终端获焦);Linux 的 Ctrl+V 照常发 `^V`(readline 的「逐字插入」)。
   - 执行作用于触发窗口的活动终端,与终端右键菜单「复制 / 粘贴」同一实现:粘贴先剥离控制字符(防 pastejacking,
     见 `terminal-paste-sanitize`)再 `term.paste`;复制写剪贴板,复制并清除另清掉选区。活动面板不是终端 → 什么都不做。
   - macOS 不设默认键:⌘C / ⌘V 照旧走浏览器原生复制 / 粘贴(粘贴同样经净化)。
   - 刻意差异:VSCode mac 把 ⌘C / ⌘V 绑给这两个命令(行为相同);Linux 的 Shift+Insert(VSCode PasteSelection,粘贴 X11 主选区)
     未做 —— renderer 读不到主选区,Chromium 默认把 Shift+Insert 当粘贴剪贴板。
2. **终端获焦时 Ctrl+P 打开「转到文件」**(VSCode `DEFAULT_COMMANDS_TO_SKIP_SHELL` 含 `workbench.action.quickOpen` /
   `showCommands`):Windows / Linux 的 Ctrl+P / Ctrl+Shift+P 不交给 xterm(不再发 `^P`),冒泡给 picker 监听打开面板;
   mac 的 ⌃P 照常进 shell(⌘P 本就不进 shell)。有 Modal 开着时不让出。
   同一核对(VSCode 列表里、本项目有对应命令、终端里会被 xterm 吞掉的键):调试工具栏命令(F5 继续 / F6 暂停 / F10 / F11 /
   ⇧F11 / ⇧F5,`workbench.action.debug.*`)在调试会话状态成立时胜出即让出;没有会话时 F5 照常进 shell。
   Ctrl+C / Ctrl+D / Ctrl+R / Ctrl+W / Ctrl+S / Ctrl+B / Ctrl+G 等 shell 键不让出(不在 VSCode 列表里或没有对应命令)。
3. **Windows / Linux 只有一条标题栏**:主窗是原生标题栏(`titleBarStyle: 'default'`,显示 `document.title`)+ 原生菜单栏,
   应用内 `<TitleBar />` 只在 macOS 渲染;窗口标题照常同步(「文件 ● · 工作区」)。VSCode `window.titleBarStyle = native` 时同样
   只有原生标题栏。刻意差异:VSCode Windows / Linux 默认是自绘标题栏(custom),Continuo 用原生标题栏。
4. **菜单栏助记符**(VSCode `mnemonicMenuLabel`,`window.enableMenuBarMnemonics` 默认开):顶层菜单标签在 catalog 里用 `&&`
   标助记符 —— en「&&File / &&Edit / &&Selection / &&View / &&Go / &&Terminal / &&Window / &&Help」,zh「文件(&&F)…」、
   ko「파일(&&F)…」(同 VSCode 语言包)。Windows / Linux 上 `&&` → Electron 的 `&`(Alt+F 打开「文件」),标签文本里本身的
   `&` 转义成 `&&`;macOS 去掉 `(&&X)` 与 `&&`。子菜单项不加助记符(刻意差异:VSCode 子项也有),只做转义。
5. **「在 Finder 中显示」/「废纸篓」按平台措辞**(VSCode `REVEAL_IN_OS_LABEL`、删除确认 `isWindows` 选 Recycle Bin 文案):
   - 资源管理器 / 编辑器 tab 右键「在 Finder 中显示」:Windows「在文件资源管理器中显示 / Reveal in File Explorer /
     파일 탐색기에 표시」,Linux「打开所在的文件夹 / Open Containing Folder / 상위 폴더 열기」;命令面板「在 Finder 中显示活动文件」同理;
   - 删除确认 / 永久删除确认 / 撤销提示 / 删除失败提示 / 「移到废纸篓」按钮 / 设置项说明:Windows 用「回收站 / Recycle Bin」
     (ko 两者都是「휴지통」,同 VSCode);Linux 同 macOS(「废纸篓 / Trash」,VSCode Linux 同)。
   - 实现:catalog 加 `<key>_win` / `<key>_linux` 变体,`osVariantKey(key)` 按运行平台选用(无变体 / 平台无法识别 → 原 key)。
6. **Windows 关闭编辑器 Ctrl+F4**(VSCode editorCommands `win: { primary: Ctrl+F4, secondary: [Ctrl+W] }`):Windows 上
   `workbench.action.closeActiveEditor` 主键 Ctrl+F4、附加 Ctrl+W(菜单 / tab 右键显示 Ctrl+F4);其它平台不变。终端里 Ctrl+F4
   不让出(关闭编辑器不在 commandsToSkipShell,只认 Meta,同 VSCode)。
7. **Windows 终端右键 = 复制 / 粘贴**(VSCode `terminal.integrated.rightClickBehavior` 默认
   `isMacintosh ? 'selectWord' : isWindows ? 'copyPaste' : 'default'`,`handleMouseEvent`):Windows 上鼠标右键有选区 → 复制并
   清除选区、没有选区 → 粘贴,不弹菜单;Shift+右键、键盘(Shift+F10 / 菜单键)照常弹菜单。mac(右键选词 + 菜单)与 Linux(菜单)不变。
8. **Windows / Linux 不再 Ctrl+M 最小化窗口**:窗口菜单的「最小化」在非 mac 不用 Electron `role: 'minimize'`(它自带
   `CommandOrControl+M`,焦点不在编辑器时按 Ctrl+M 就最小化窗口;VSCode Windows / Linux 没有最小化键),改为无键位的显式项。
   macOS 保留 role(⌘M)。

## 规范

- `terminal-clipboard.spec.tsx`(1、2:命令定义 / 注册 / 让出判定 / useTerminal 接线)
- `terminal-right-click.spec.tsx`(7)
- `title-bar-menu.spec.tsx`(3、4、8)
- `platform-labels.spec.tsx`(5、6)
