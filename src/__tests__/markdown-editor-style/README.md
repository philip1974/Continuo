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
- 浮层不越出窗口:斜杠菜单(Crepe 只挂 flip + offset)追加「水平夹回视口」中间件,窄窗口(640 宽)光标靠右时左移到距右边 8px;
  斜杠菜单 / 选区工具条 / 链接气泡与输入框 `max-width: calc(100vw - 16px)` 兜底,菜单分组页签放不下时横向滚动。
- 代码块工具条键盘可见(WCAG 2.4.7):Crepe 的语言按钮 / 复制按钮只在 :hover 时显示;代码块内有焦点或按钮键盘聚焦(:focus-visible)
  时同样显示,按钮键盘聚焦画 `--md-focus-ring` 焦点环。只读 Preview 不能改语言,不显示语言按钮(Tab 不再停在看不见、无作用的按钮上),
  复制按钮保留。
- 列表序号 / 圆点 / 勾选框盒高度与行高按段落同一公式(1.5em 行高 + 上下 4px)随字号计算,任意字号下与首行文字对齐(Crepe 固定 32px 只在 16px 时对齐)。

## Modules

| File | Role |
|---|---|
| `src/styles/milkdown-font-override.css` | Crepe 变量 / 字号 / 内边距 / 表格布局覆写(在 Crepe 主题 CSS 之后 import) |
| `src/panels/Editor/milkdown-floating-clamp.ts` | 斜杠菜单水平夹回视口的 floating-ui 中间件 |
| `src/panels/Editor/MilkdownEditor.tsx` | 外层容器按 `editor.fontSize` 写 `font-size` 与 `--crepe-base-font-size` |

## Specs

| File | 覆盖 |
|---|---|
| `milkdown-style-override.spec.ts` | 覆写 CSS 的声明契约(变量接 token、字号继承、内边距 clamp / 手柄下限、表格 auto 布局、列表序号盒随字号) |
| `floating-viewport-clamp.spec.tsx` | 斜杠菜单夹回视口中间件(放得下不动 / 右越界左移 / 超宽贴左)、接入 BlockEdit.slashMenu、浮层 max-width 兜底 |
| `wrapper-font-size-var.spec.tsx` | 外层容器同时写入字号与 `--crepe-base-font-size` |
| `tests/e2e/markdown-editor-style.spec.ts` | 真实 Electron 计算样式:字体、字号随设置(含代码块占位层)、窄宽内边距与块手柄位置、表头不断词、有序列表序号与首行文字同一行(10 / 28px) |
