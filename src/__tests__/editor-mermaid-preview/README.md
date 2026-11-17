# editor-mermaid-preview

Markdown 里的 ```` ```mermaid ```` 围栏代码块(流程图 / 时序图 / 甘特图等)在 Edit 与 Preview 模式下渲染成图,而不是只显示源码。Source 模式不受影响。

## Contracts

- 语言为 `mermaid`(大小写不敏感)且内容非空的代码块:Preview 模式只显示图;Edit 模式显示源码 + 下方图预览,改源码后图跟着更新。
- 其它语言、空内容的代码块没有预览区(行为与此前一致)。
- mermaid 库按需加载:文档里没有 mermaid 代码块时不加载。
- 渲染使用 `securityLevel: 'strict'` + `htmlLabels: false`(输出静态 SVG,无脚本 / 点击回调 / 内嵌 HTML)。图表源码里的 `%%{init}%%` 指令改不了这些加固项(`secure` 列表,另含 `themeCSS`)。
- 图的配色取自应用语义 token(`--md-*`,mermaid `base` 主题变量),随 light / dark 变化;token 读不到时退回 mermaid 内置的 `dark` / `default`。
- 切换主题(含跟随系统的自动切换,可能发生在输入途中)时,已显示的图**就地重画**,编辑器不重挂载:光标、滚动位置、刚输入的内容都保留。
- 图语法错误时预览区显示本地化的错误提示 + 转义后的错误信息,不抛异常、不向页面注入源码里的 HTML。
- 在一个代码块里连续输入时不逐键渲染(大图单次渲染几百毫秒,会让打字卡顿):停手约 250ms 后只渲染最后一版。认不出是哪个块在改时(首次挂载、两个块内容相同)照常立即渲染。
- 同一代码块连续修改时,预览按修改顺序落地(后一次渲染不会被先一次的迟到结果覆盖);渲染在途时代码块被清空或改成别的语言,迟到的旧图不会再冒出来。
- 代码块工具条文案(复制 / 搜索语言 / 预览 / 隐藏 / 加载中)走 i18n catalog,随应用语言显示;切换语言后视图重新挂载以刷新文案。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/mermaid-preview.ts` | mermaid 懒加载单例 + Crepe `renderPreview` 实现 + 主题切换时的就地重画 |
| `src/panels/Editor/MilkdownEditor.tsx` | 把预览渲染器与本地化文案接进 Crepe CodeMirror 特性;主题变化时触发重画,语言变化时重挂载 |
| `src/styles/milkdown-font-override.css` | 图 / 错误提示在预览区内的样式(语义 token) |
| `tests/e2e/markdown-mermaid-preview.spec.ts` | 真实 Electron 里 Preview / Edit 渲染出 SVG |
