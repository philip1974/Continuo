# markdown-editor-style

行为契约:**Markdown 编辑器(Milkdown / Crepe,Edit 与 Preview)的字体、阴影、字号、正文内边距跟随项目设计 token 与设置,窄宽下仍可读。**

## 行为

- 正文与标题用 `--wm-font-sans`,代码用 `--wm-font-mono`(不再是 Crepe frame-dark 的 Noto Serif / Space Mono)。
- 浮层(工具条 / 菜单 / 提示)阴影用 `--wm-shadow-popover`,亮 / 暗各自取值(不再是暗色白辉光)。
- 字号跟随设置 `editor.fontSize`(Crepe ≥7.22 在 `.milkdown` 上写死 `--crepe-base-font-size`,本项目改回继承外层容器);
  `--crepe-base-font-size` 本身也由外层容器按设置写入、`.milkdown` 继承,代码块占位层与真实 CodeMirror 字号一致,
  懒创建 / 回收时高度不跳变。
- 正文内边距随编辑区宽度收缩(宽屏封顶 Crepe 原值 60px / 120px,窄宽最少 16px);Edit 模式左侧下限 88px,
  放得下块手柄(2×32px 按钮 + 2px 间距 + 16px 偏移 = 82px),窄宽下手柄不翻到右侧、不被裁;只读 Preview 无手柄,左侧同右侧。
- 表格按内容分配列宽,列不窄于最长单词(表头不在单词中间断开),放不下时横向滚动。

## Modules

| File | Role |
|---|---|
| `src/styles/milkdown-font-override.css` | Crepe 变量 / 字号 / 内边距 / 表格布局覆写(在 Crepe 主题 CSS 之后 import) |
| `src/panels/Editor/MilkdownEditor.tsx` | 外层容器按 `editor.fontSize` 写 `font-size` 与 `--crepe-base-font-size` |

## Specs

| File | 覆盖 |
|---|---|
| `milkdown-style-override.spec.ts` | 覆写 CSS 的声明契约(变量接 token、字号继承、内边距 clamp / 手柄下限、表格 auto 布局) |
| `wrapper-font-size-var.spec.tsx` | 外层容器同时写入字号与 `--crepe-base-font-size` |
| `tests/e2e/markdown-editor-style.spec.ts` | 真实 Electron 计算样式:字体、字号随设置(含代码块占位层)、窄宽内边距与块手柄位置、表头不断词 |
