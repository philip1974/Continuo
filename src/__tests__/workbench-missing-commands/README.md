# workbench-missing-commands

补齐 VSCode 常用但 Continuo 此前缺失的命令 / 默认键(第四十轮审计)。命令一律走命令注册表 → 快捷键设置页(改键 / 解绑 /
冲突)、`isHotkeyShadowed`、`resolveDisplayHotkey`、命令面板自动覆盖。多默认键模型见 `src/__tests__/command-secondary-hotkeys/`。

## §1 附加默认键(`additional-default-keys.spec.ts`)

| 命令 | 主键 | 附加默认键 | 说明 |
|---|---|---|---|
| `workbench.action.nextEditor` / `previousEditor` | mac ⌥⌘→ / ⌥⌘← | mac ⇧⌘] / ⇧⌘[ | Windows / Linux 无附加键(VSCode 同) |
| `terminal.new` | ⌘T / Ctrl+T | ⌃⇧`(各平台) | VSCode `workbench.action.terminal.new`;终端里让出(commandsToSkipShell) |
| `workbench.action.showCommands` | ⇧⌘P(保留键,picker 处理) | F1(各平台) | F1 进命令分发;终端里让出 |

- ⇧⌘[ / ⇧⌘] 按物理键匹配(e.key 为上档字符 `{` / `}` 也认),编辑器面板内同样就地切换(面板裁决同一张表)。

## §2 全部保存(`save-all.spec.ts`)

- `workbench.action.files.saveAll`,mac ⌥⌘S;Windows / Linux 在 VSCode 是组合键 Ctrl+K S,Continuo 不支持组合键 → 无默认键
  (可在快捷键设置里绑)。三语标题「全部保存」。
- 先把编辑器里尚未上抛的输入写回 store(Milkdown 自适应延迟),再把**所有编辑器组**里的脏文件 tab 逐个交给其所在组的面板保存
  (`EditorPanelActions.saveTabForSaveAll`);干净 tab 与图片 tab(只读)不保存。
- 失败处理同 ⌘S:磁盘已被外部修改 → 覆盖确认;写保护 → 覆盖写保护确认;其它 → 按 code 提示「保存失败 <文件名>」。一次全部保存
  **最多弹一个确认框**,之后的确认类失败只提示(不叠框、不互相覆盖)。
- Continuo 没有无标题(untitled)编辑器:每个 tab 都有路径;已被删除的文件按 ⌘S 的现有约定重建。
- popout 子窗里不分发(保存失败的确认框画在各编辑器组所在窗口)。

## §3 打开最近的文件夹(`open-recent.spec.tsx`)

- `workbench.action.openRecent`,mac ⌃R;Windows / Linux 不设默认键(VSCode 是 Ctrl+R,但 Continuo 应用菜单「重新加载窗口」占用
  CmdOrCtrl+R)。三语标题「打开最近的文件夹…」。
- 打开一个 Quick Pick(与命令面板 / Quick Open 互斥,同一套 picker 列表机制):列出「最近打开」的文件夹(当前文件夹除外,同资源管理器
  「打开最近」菜单),名称 + 父路径,输入模糊过滤(名称与完整路径),↑↓ / Enter / 点击打开,Esc 关闭;无最近项 → 空态提示。
- 打开走「最近打开」同一路径(`openRecentRootOrNotify`):已在别的窗口打开 → 聚焦那个窗口(去重);目录已不存在 → 询问是否从
  列表删除(picker 关闭后仍显示);切换后焦点交给新文件树(`switchToCheckedRoot` / `focusTreeAfterRootSwitch`)。
- 终端获焦时 ⌃R 留给 shell(反向搜索历史;VSCode commandsToSkipShell 不含),不打开 picker。
- **⌘Enter / ⌘ 单击(Windows / Linux Ctrl)在新窗口打开**(VSCode openRecent `keyMods.ctrlCmd → forceNewWindow`):走与「在新窗口打开
  文件夹…」相同的 `window.create({ workspace })`(main 发现已在某个窗口打开 → 聚焦那个窗口,不开第二个),本窗口 root / 焦点不变;
  目录已不存在 → 同样询问是否删除(`openRecentRootInNewWindow`,`workspace-window-dedupe/renderer-entries.spec.ts`)。占位文字照抄
  VSCode 的修饰键提示(mac「hold Cmd-key to force new window or Option-key for same window」,其它平台 Ctrl / Alt),三语。
  VSCode 的行尾按钮是「从最近打开中删除 / 已在窗口中打开」,没有「在新窗口中打开」按钮,这里也不加。

## §4 切换自动换行(`toggle-word-wrap.spec.tsx`)

- `editor.action.toggleWordWrap`,各平台 ⌥Z / Alt+Z(mac 上 e.key 为 Ω,按物理键匹配)。三语标题「切换自动换行」。
- 新设置 `editor.wordWrap`(布尔,默认关,设置 › 编辑器 › 外观);命令翻转它,所有已打开的代码编辑器即时 reconfigure
  (CodeMirror `EditorView.lineWrapping`,Compartment 热切,不重建视图、不丢撤销历史)。Markdown 编辑 / 预览本就折行,不受影响。
- 与 VSCode 的差异(取极简):VSCode 的 ⌥Z 只改**当前文件**的临时状态(不写设置、按文件记住,重启丢失),设置
  `editor.wordWrap` 另行控制默认。Continuo 此前没有任何换行设置,只做一个全局开关:命令与设置页是同一个值,持久化、跨窗同步,
  不引入按文件的临时状态。
- 终端获焦时 ⌥Z 留给 shell;popout 子窗里也分发(只翻转设置)。

## §5 终端获焦时留给终端的键

对齐 VSCode(终端获焦时,不在 commandsToSkipShell 里的键交给 xterm,不触发工作台命令):后退 / 前进(⌃- / ⌃⇧-,Win/Linux
Alt+← / Alt+→)、打开最近(⌃R)、切换自动换行(⌥Z)胜出时,终端照常把按键交给 xterm 并截住冒泡(`isTerminalKeptHotkey`),全局分发
不执行、焦点留在终端。带 ⌘ 的(改绑)键照常交给工作台。⌃⇧`(新建终端)、F1(显示所有命令)反之在 commandsToSkipShell 里 → 让出(§1)。
