# editor-milkdown-chrome-i18n

Markdown Edit 模式(Milkdown / Crepe)里的浮层文案随应用语言(en / zh / ko)显示。Crepe 7.23 默认全英文,只能经 `featureConfigs` 传入。

## Contracts

- 斜杠菜单(BlockEdit):分组名(文本 / 列表 / 高级)与条目名(正文、一至六级标题、引用、分隔线、无序 / 有序 / 任务列表、代码块、表格)取自 catalog `panels.editor.md.slash.*`。
- 选区浮动工具条(Toolbar):粗体 / 斜体 / 删除线 / 行内代码 / 链接的按钮名(`title` 与 `aria-label`)取自 `panels.editor.md.toolbar.*`。
- 链接输入框(LinkTooltip)占位符取自 `panels.editor.md.link.placeholder`。
- zh / ko 下上述各项都不是 Crepe 的英文默认值。
- 切换应用语言后编辑器以当前内容重挂(`MilkdownProvider` 以 locale 为 key),浮层文案换成新语言。不能就地换文案:Crepe 7.23 没有
  运行时更新 `featureConfigs` 的接口(工具条 / 斜杠菜单的 Vue computed 不追踪普通 config 对象,代码块工具条文案在节点视图创建时读取)。
- 切换语言重挂后还原(BDD `milkdown-relocale-state.spec.tsx`):选区(含反向选择,位置夹进新文档)与焦点 —— 切换前焦点在编辑区
  (含代码块)才重新聚焦,否则不抢焦点;滚动位置按视图状态缓存恢复。查找条渲染在 `MilkdownProvider` 外,不随之重挂(查找框焦点
  与输入保留);查找条开着时,还原选区后按还原的选区重算当前匹配 —— 计数 / 当前高亮与切换前一致(不退回 1 / N),下一次「查找下一个」
  从它接着走。**撤销历史不保留**:它是旧 EditorState 里 prosemirror-history 的插件状态,而 Milkdown 每个实例自建 schema,历史里的
  步骤属于旧 schema,不能搬进新实例。
- Crepe 未暴露为配置、仍为英文的:代码块语言选择器在未选语言时显示的 `Text`(@milkdown/components language-picker 硬编码);工具条分组名 `Formatting` / `Function` 不渲染,无影响。标题下拉(`Paragraph` / `Heading 1`)属于 TopBar 特性,Continuo 未启用。图片 / 数学公式特性未启用,其菜单项不出现、不配置。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/MilkdownEditor.tsx` | `featureConfigs` 把 BlockEdit / Toolbar / LinkTooltip 文案接到 catalog |
| `electron/shared/i18n-locales/{en,zh,ko}.ts` | `panels.editor.md.*` 三语文案 |
| `milkdown-chrome-i18n.spec.tsx` | 每个 locale 下各项 = catalog 值且非英文默认;切换语言重挂 |
| `milkdown-relocale-state.spec.tsx` | 真实 Crepe:切换语言重挂后选区 / 焦点还原、查找条不重挂、当前匹配不变 |
