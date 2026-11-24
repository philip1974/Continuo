# keybinding-user-priority

快捷键冲突时**用户设置的绑定优先于默认绑定**(对齐 VSCode:keybindings.json 的用户绑定压过扩展 / 内置默认):

- 全局热键分发表(`useCommandHotkeys` 的 `buildCompiledBindings`)先放有用户 override 的命令,再放默认绑定的命令;
  同一层内保持注册顺序。同一按键命中多条时取表中第一条 → 用户刚设的键生效,原默认命令让出。
- `selectShadowedBindings`:与分发同一张表、同一按键签名(修饰键 + 主键别名归一)算出「冲突落败」的命令 → 胜出者。
  保留键 / 解绑 / 未知修饰符的绑定不入表,不参与冲突。
- 设置 › 快捷键列表:冲突落败的行标注「冲突」(三语),悬停提示由哪个命令响应。
- 录键弹窗:
  - 冲突项是按钮,点击关闭弹窗并把列表搜索框设成该快捷键(列出所有用这个键的命令,同 VSCode「显示相同的键绑定」)。
  - 有冲突时 Enter 不保存(须看过警告再点「保存」),提示行相应改为「有冲突,点击「保存」确认保存」,不再写 Enter 保存。
  - 冲突说明按保存后的真实结果给出:本命令会胜出 →「保存后由本命令响应此快捷键」;冲突命令也是用户设置且先注册 →
    「保存后仍由「X」响应,请先在那边解绑」。

### 面板 / 终端与全局分发一张表裁决(`panel-arbitration.spec.tsx`、`terminal-vscode-parity/skip-shell-hotkeys.spec.ts`)

对齐 VSCode(一张 keybinding 表裁决,一键一个动作):`winningCommandFor(event, commands, platform, overrides)` 与全局分发、
「冲突」标注同表同序(`buildCompiledBindings`,同签名第一条胜出)。

- 编辑器面板 `onKeyDown` 只在胜出命令是保存 / 下一个 / 上一个编辑器时就地处理;别的命令占了该键(如新建终端绑到 ⌘S 并胜出)
  → 面板不保存,由全局分发执行那个命令(只执行一次)。编辑器内容已处理的键(`defaultPrevented`,如保存改绑到 ⌘D / ⌘/
  时 CodeMirror 的选中下一处 / 切换注释)面板与全局分发都不再保存。
- 终端只在胜出命令是清屏 / 关闭 / 保存(再按 VSCode 让出规则:关闭 / 保存须带 Meta)或缩放 / 搜索时让出;⌘K 绑给别的命令
  并胜出 → 终端不清屏。命令尚未注册时按约定默认键兜底(`withDefaultCommands`)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/command-palette/useCommandHotkeys.ts` | 分发表排序、`selectShadowedBindings`、`winningCommandFor` / `withDefaultCommands` |
| `src/panels/Editor/EditorPanel.tsx` | 面板 onKeyDown 按胜出命令处理 |
| `src/panels/Terminal/terminal-hotkeys.ts` | 终端让出按胜出命令判定 |
| `src/plugins/command-palette/format-hotkey.ts` | `hotkeyFilterQuery`(按键过滤的搜索串,与列表 haystack 同一形式) |
| `src/plugins/settings/KeybindingsTabContent.tsx` | 「冲突」标注、按快捷键过滤 |
| `src/plugins/keybindings/KeybindingCaptureModal.tsx` | 冲突按钮、提示行、冲突说明 |

e2e:`tests/e2e/hotkey-conflict-first-wins.spec.ts`(用户 override 胜出)、`tests/e2e/keybinding-capture-conflict.spec.ts`。
