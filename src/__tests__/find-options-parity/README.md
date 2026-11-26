# 三处查找的选项一致(名称 / tooltip 快捷键 / 切换键)

行为契约(对齐 VSCode findInput:编辑器查找控件、Search 视图、终端查找共用同一组选项):**编辑器查找面板(⌘F)、在文件中查找
(⇧⌘F)、终端查找条与 Markdown 查找条(复用终端查找条)的「区分大小写 / 全字匹配 / 使用正则表达式」名称相同,tooltip 带快捷键,
且都认同一组切换键。**

## 行为

- **切换键**:mac ⌥⌘C / ⌥⌘W / ⌥⌘R,Windows / Linux Alt+C / W / R(多带 Shift / Ctrl 不算;mac 单按 ⌥C 不算 —— 那是输入 ç)。
  主键按物理键判:macOS 按住 ⌥ 时 `e.key` 是特殊字符(ç / ∑ / ®)。
  - 在文件中查找:焦点在视图内(查询框、包含 / 排除框、结果树、选项按钮)即生效,翻转对应开关并重新搜索。
  - 终端 / Markdown 查找条:焦点在查找条内(查找框或其按钮)即生效;焦点在终端本身时按键照常进 shell。
  - 编辑器查找面板:原有 CodeMirror keymap(面板打开时查找框与编辑区都生效),同一组键。
  - IME 组合中的按键不处理。
- **名称**(共享 catalog 键 `find.option.match_case / whole_word / regex`,选项组 `find.options_group`):
  en Match Case / Match Whole Word / Use Regular Expression;zh 区分大小写 / 全字匹配 / 使用正则表达式;
  ko 대/소문자 구분 / 단어 단위로 / 정규식 사용(VSCode ko 语言包)。原各界面各自的键(`editor.cm.match_case / regexp /
  by_word`、`panels.terminal.search.regex / case_sensitive / whole_word / options_group`)删除。
- **tooltip**:选项按钮 / 复选框悬停「区分大小写 (⌥⌘C)」(Windows / Linux「(Alt+C)」);可访问名称仍是纯名称。编辑器查找面板的
  按钮也有 tooltip:下一个 (Enter)、上一个 (⇧Enter)、关闭 (Escape 键位),全部 / 替换 / 全部替换只有名称。

- **顺序 / 字形 / 样式**(第三十轮审计):三处都是 **Aa(区分大小写)/ ab(全字匹配)/ .*(正则)** 同顺序的 toggle,位于查找框
  之后(VSCode findInput)。
  - 终端 / Markdown 查找条与在文件中查找共用 `FindOptionToggles`(role=group「搜索选项」内三个 `aria-pressed` 的 design
    `IconButton` xs,按钮 className 相同);按下态 = 主色浅底 + 1px 主色内描边(design `IconButton[aria-pressed=true]`,VSCode
    inputOption.activeBackground / activeBorder)。
  - 编辑器查找面板(CodeMirror 默认面板,代码文件 + Markdown 源码 + Markdown 代码块)的三个复选框按同顺序移进查找框(计数)后的
    role=group「搜索选项」,外观改为同尺寸 / 同按下态的 toggle(字形 aria-hidden,选项名视觉隐藏 —— 可访问名不变);仍是原生
    复选框:勾选态随 CodeMirror 查找状态同步,点击 / 空格 / ⌥⌘C/W/R 照常翻转。

## Modules

| File | Role |
|---|---|
| `src/lib/find-options.ts` | 共享:选项名称键、`findOptionHotkey`(平台键)、`matchFindOptionHotkey`(按键 → 选项)、`findOptionTooltip` |
| `src/lib/FindOptionToggles.tsx` | 终端 / Markdown 查找条与在文件中查找共用的选项 toggle 组(`FIND_OPTIONS` 顺序 + `FIND_OPTION_GLYPHS`) |
| `src/design/IconButton.css` | `aria-pressed=true` 按下态 |
| `src/lib/hotkey-label.ts` | `withHotkey`「名称 (键位)」/ `hotkeyText` |
| `src/panels/Search/SearchPanel.tsx` | 视图根节点 keydown 切换;选项按钮名称 / tooltip |
| `src/panels/Terminal/TerminalSearchBar.tsx` | 查找条根节点 keydown 切换;选项按钮名称 / tooltip(Markdown 查找复用) |
| `src/panels/Editor/codemirror-find.ts` / `codemirror-phrases.ts` | 面板复选框 / 按钮 tooltip;复选框排成 Aa / ab / .* toggle(`arrangeOptionToggles`);选项 phrase 映射到共享键 |
| `src/panels/Editor/code-editor-theme.ts` | CodeMirror 选项 toggle 外观(同 IconButton xs) |

## Specs

- `find-options-parity.spec.tsx`
