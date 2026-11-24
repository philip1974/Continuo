# editor-milkdown-chrome-i18n

Markdown Edit 模式(Milkdown / Crepe)里的浮层文案随应用语言(en / zh / ko)显示。Crepe 7.23 默认全英文,只能经 `featureConfigs` 传入。

## Contracts

- 斜杠菜单(BlockEdit):分组名(文本 / 列表 / 高级)与条目名(正文、一至六级标题、引用、分隔线、无序 / 有序 / 任务列表、代码块、表格)取自 catalog `panels.editor.md.slash.*`。
- 选区浮动工具条(Toolbar):粗体 / 斜体 / 删除线 / 行内代码 / 链接的按钮名(`title` 与 `aria-label`)取自 `panels.editor.md.toolbar.*`。
- 链接输入框(LinkTooltip)占位符取自 `panels.editor.md.link.placeholder`。
- zh / ko 下上述各项都不是 Crepe 的英文默认值。
- 切换应用语言后编辑器以当前内容重挂(`MilkdownProvider` 以 locale 为 key),浮层文案换成新语言。
- Crepe 未暴露为配置、仍为英文的:代码块语言选择器在未选语言时显示的 `Text`(@milkdown/components language-picker 硬编码);工具条分组名 `Formatting` / `Function` 不渲染,无影响。标题下拉(`Paragraph` / `Heading 1`)属于 TopBar 特性,Continuo 未启用。图片 / 数学公式特性未启用,其菜单项不出现、不配置。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/MilkdownEditor.tsx` | `featureConfigs` 把 BlockEdit / Toolbar / LinkTooltip 文案接到 catalog |
| `electron/shared/i18n-locales/{en,zh,ko}.ts` | `panels.editor.md.*` 三语文案 |
| `milkdown-chrome-i18n.spec.tsx` | 每个 locale 下各项 = catalog 值且非英文默认;切换语言重挂 |
