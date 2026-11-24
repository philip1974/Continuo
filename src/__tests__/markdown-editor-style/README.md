# markdown-editor-style

行为契约:**Markdown 编辑器(Milkdown / Crepe,Edit 与 Preview)的字体、阴影、字号、正文内边距跟随项目设计 token 与设置,窄宽下仍可读。**

## 行为

- 正文与标题用 `--wm-font-sans`,代码用 `--wm-font-mono`(不再是 Crepe frame-dark 的 Noto Serif / Space Mono)。
- 浮层(工具条 / 菜单 / 提示)阴影用 `--wm-shadow-popover`,亮 / 暗各自取值(不再是暗色白辉光)。
- 字号跟随设置 `editor.fontSize`(Crepe ≥7.22 在 `.milkdown` 上写死 `--crepe-base-font-size`,本项目改回继承外层容器)。
- 正文内边距随编辑区宽度收缩(宽屏封顶 Crepe 原值 60px / 120px,窄宽最少 16px)。
- 表格按内容分配列宽,列不窄于最长单词(表头不在单词中间断开),放不下时横向滚动。

## Modules

| File | Role |
|---|---|
| `src/styles/milkdown-font-override.css` | Crepe 变量 / 字号 / 内边距 / 表格布局覆写(在 Crepe 主题 CSS 之后 import) |

## Specs

| File | 覆盖 |
|---|---|
| `milkdown-style-override.spec.ts` | 覆写 CSS 的声明契约(变量接 token、字号继承、内边距 clamp、表格 auto 布局) |
| `tests/e2e/markdown-editor-style.spec.ts` | 真实 Electron 计算样式:字体、字号随设置、窄宽内边距、表头不断词 |
