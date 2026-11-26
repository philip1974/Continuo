# 转到行 / 列(⌃G,Quick Open `:`)

对齐 VSCode `workbench.action.gotoLine` 与 Quick Open 的 `:` 前缀(GotoLineQuickAccessProvider)。此前 ⌃G 无反应、随后键入的
`300⏎` 写进正文;只有 CodeMirror 自带的 ⌘⌥G 小面板,命令面板搜不到,⌘P 不认 `:行号`。

1. **命令**:`workbench.action.gotoLine`,三语标题「转到行/列…」,默认键 `ctrl+g` —— mac 是 ⌃G(Control,不是 ⌘),
   Windows / Linux 是 Ctrl+G(VSCode 同)。经命令注册表接入快捷键页(改键 / 解绑 / 冲突)、命令面板键位显示、
   `isHotkeyShadowed` / `resolveDisplayHotkey`;Modal / 菜单打开时不分发(全局分发同一规则)。
2. **执行** → 打开 Quick Open 并预填 `:`(命令面板开着则先关掉,两 picker 互斥);光标在 `:` 之后,接着键入的数字进输入框,
   不进编辑器正文。
3. **`:` 模式**(⌃G 预填,或在 ⌘P 里手动键入 `:`):
   - 目标 = 触发窗口的编辑器组(`commandEditorGroupId`)的活动文本编辑器(CodeMirror 视图);
   - `:N` / `:N:C`(也认 `N,C`、`N#C`;负数行从末尾数,`:-1` = 最后一行)→ 列表只有一行「转到第 N 行。」/「转到第 N 行第 C 个
     字符。」,**实时预览**:光标移到目标并居中,焦点留在输入框;
   - 行号越界夹到 `[1, 行数]`,列超出行长落在行尾(按产品要求夹取;VSCode 越界时不跳);
   - 只有 `:` / 没有数字 → 提示「当前行:L,字符:C。键入要导航到的行号(介于 1 和 N 之间)。」,不移动;
   - **Enter** → 关闭 Quick Open,光标落到目标、居中,焦点回到编辑器(从命令面板执行也一样);
   - **Esc** 取消(或删掉 `:` 回到文件搜索)→ 光标与滚动位置回到打开前(VSCode:未确认则恢复视图状态);
   - 没有活动文本编辑器(无 tab、图片、Markdown 编辑 / 预览模式)→ 提示「请先打开文本编辑器，然后再转到行。」,Enter 无动作;
   - 无工作区时同样可用(不显示「请先打开工作区」)。
4. **CodeMirror 键位去冲突**(`codemirror-basic-setup.ts`):去掉 basicSetup 的 `Mod-Alt-g`(自带转到行小面板);`Mod-g` /
   `Shift-Mod-g`(查找下一个 / 上一个)只在 mac 保留(⌘G / ⇧⌘G);Windows / Linux 的 Ctrl+G 不再被 CodeMirror 当查找下一个
   吞掉(VSCode Win/Linux 的查找下一个是 F3 / 查找框内 Enter,F3 / ⇧F3 照旧)。
5. **终端里**:⌃G 不让出,照常进 shell(VSCode commandsToSkipShell 不含 gotoLine)。popout 子窗不分发(Quick Open 画在主窗,
   与 ⌘P 同一规则)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/quick-open/goto-line.ts` | `:` 查询解析、夹取(纯函数) |
| `src/plugins/quick-open/use-goto-line.ts` | 目标解析、实时预览、Enter 跳转、取消恢复、提示文案 |
| `src/plugins/quick-open/QuickOpenModal.tsx` | `:` 模式下的列表 / 提示与 Enter |
| `src/panels/Editor/editor-commands.ts` | `GOTO_LINE_COMMAND`、`openGotoLine` 与命令 spec |
| `src/panels/Editor/codemirror-basic-setup.ts` | 去掉冲突查找键的 basicSetup |
| `src/panels/Editor/scrollToLine.ts` | 跳行(`focus: false` 供预览) |

## 规范

- `goto-line-parse.spec.ts`:解析与夹取
- `goto-line-command.spec.ts`:命令注册、执行、⌃G 分发、终端不让出
- `goto-line-quick-open.spec.tsx`:Quick Open `:` 模式(预览 / Enter / Esc / 越界 / 无编辑器)
- `codemirror-keys.spec.ts`:CodeMirror 键位去冲突
