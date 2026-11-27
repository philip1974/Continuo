# 语言功能类编辑器命令:格式化 / 重命名 / 转到定义 / 快速修复 / 下一个问题 / 触发建议 / 扩展·收缩选区

VSCode 迁移用户在代码编辑器(CodeEditor)里按 ⌥⇧F、F2、F12、⌘.、F8 静默无反应;⌘I 做的是 CodeMirror 的「扩展到父语法节点」
而不是 VSCode 的触发建议。对齐 VSCode 的命令 id、英文标题与默认键,经命令注册表分发(条件 `editorTextFocus`,快捷键页可改键 /
解绑),作用于触发窗口活动编辑器组的文本编辑器(同 `editor-text-commands`)。

| id | 标题 | mac | Windows / Linux |
|---|---|---|---|
| `editor.action.formatDocument` | Format Document | ⇧⌥F | Shift+Alt+F |
| `editor.action.rename` | Rename Symbol | F2 | F2 |
| `editor.action.revealDefinition` | Go to Definition | F12 | F12 |
| `editor.action.quickFix` | Quick Fix... | ⌘. | Ctrl+. |
| `editor.action.marker.nextInFiles` | Go to Next Problem in Files (Error, Warning, Info) | F8 | F8 |
| `editor.action.triggerSuggest` | Trigger Suggest | ⌃Space(另有 ⌥Esc、⌘I) | Ctrl+Space(另有 Ctrl+I) |
| `editor.action.smartSelect.expand` | Expand Selection | ⌃⇧⌘→(另有 ⌃⇧→) | Shift+Alt+→ |
| `editor.action.smartSelect.shrink` | Shrink Selection | ⌃⇧⌘←(另有 ⌃⇧←) | Shift+Alt+← |

1. **格式化文档**:
   - JSON(`.json` / `.jsonc` / `.json5`,语言为 JSON 的文件):`{` / `[` 后换行缩进一层、`,` 后换行、`:` 后一个空格、空对象 /
     空数组写成 `{}` / `[]`;一层缩进取编辑器当前缩进单位(CodeMirror `indentUnit`,随文件缩进 / 设置)。只重排空白:数字、字符串
     逐字符保留(`1.0`、`é`、超出双精度的大整数、重复键都不变),注释(jsonc)保留在原处,行尾注释仍在同一行;文末换行有则
     保留、无则不加。一次撤销恢复原文;只替换真正变化的中间部分,光标不被甩到文首 / 文末。已格式化 → 不产生修改。
   - 尾逗号(`{"a": 1,}`、`[1, 2,]`,tsconfig.json / settings.json 等 jsonc 常见)→ 照常格式化,尾逗号**原样保留**(VSCode JSON 格式化
     用 jsonc-parser `format`,只按 token 排版、不删尾逗号;`.json` 与 `.jsonc` 一样,`.json` 里 VSCode 另有「Trailing comma」诊断)。
   - JSON 语法错误(注释与尾逗号之外的错误,如缺逗号、连续逗号、`[,]`、未闭合)→ 提示「无法格式化:此 JSON 文档有语法错误,文档未改动」,
     **不改文档**(VSCode 的 token 排版对这些也会尝试排版,这里保守不改)。
   - 其它语言 → 提示 VSCode 的「There is no formatter for '<语言>' files installed.」(中文「此语言暂无格式化程序」;语言名为
     CodeMirror 语言名,纯文本为 `plaintext`)。只读文档不做。
2. **重命名 / 转到定义 / 快速修复**:本项目没有语言服务 → 按 VSCode 无结果时的文案提示,不再静默:F2「Rename Symbol: No result.」、
   F12「No definition found for '<光标处单词>'」(不在单词上「No definition found」)、⌘.「No code actions available」。
3. **下一个问题**(F8):跳到下一个诊断(CodeMirror lint,⇧⌘M 打开的诊断面板同源);没有诊断 → 提示「No problems have been
   detected in the workspace.」。
4. **触发建议**:⌃Space / ⌘I(mac 另有 ⌥Esc)打开补全列表(CodeMirror 补全)。⌘I 不再是「扩展到父语法节点」。⌃Space 同时仍在
   CodeMirror 补全自带的键表里(同一命令,补全扩展的键表随补全开关,不单独拆;改键 / 解绑只影响 ⌘I / ⌥Esc)。
5. **扩展 / 收缩选区**(VSCode smartSelect):扩展到包住选区的上一层语法节点;收缩退回上一次扩展前的选区(可连续退回);期间光标
   / 选区被别的操作改变或文档被编辑 → 扩展历史作废,收缩无效果(VSCode 同)。CodeMirror 自带的「按语法选择」(mac ⌃⇧← / ⌃⇧→,
   其它 ⇧Alt+← / ⇧Alt+→)从键表去掉,这些键归扩展 / 收缩;「按语法跳」(mac ⌃← / ⌃→)保留(见 `editor-navigation-history`)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/editor-text-commands.ts` | 命令表(id / 标题 / 默认键 / 附加默认键) |
| `src/panels/Editor/codemirror-language-commands.ts` | 各命令的 CodeMirror 实现、提示 |
| `src/panels/Editor/json-format.ts` | 只改空白的 JSON 格式化(纯函数) |
| `src/panels/Editor/codemirror-basic-setup.ts` | 键表去掉 ⌘I / F8 / 按语法选择 |

## 规范

- `json-format.spec.ts`:格式化输出、字面量 / 注释保留、缩进单位、文末换行、尾逗号保留、语法错误
- `language-commands.spec.ts`:命令键位(含附加默认键)、格式化在编辑器上的效果与撤销、各提示、键表去掉的键、扩展 / 收缩选区
