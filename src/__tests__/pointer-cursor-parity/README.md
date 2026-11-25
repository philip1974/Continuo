# 可点击控件统一手形光标

VSCode:按钮(`.monaco-button`)、状态栏项、动作栏图标、列表行等可点击控件一律 `cursor: pointer`;编辑器 / 终端 /
输入框保持文本光标。

Continuo 的 design 组件(Button / IconButton / MenuItem / TabNav / Tabs / SegmentedControl / Switch / NavRailButton)
各自已写 `cursor: pointer`,但 Tailwind v4 preflight 不再给 `<button>` 手形光标:少量注释说明过理由的原生按钮
(状态栏「Copy MCP config」、设置页左侧分类、插件市场热门标签等)悬停时是默认箭头,与其它控件不一致。

行为契约(`pointer-cursor.spec.ts`,CSS 契约):

1. **基础层一处定义**:`src/styles/theme.css` 的 `@layer base` 给 `button:not(:disabled)` 与
   `[role="button"]:not([aria-disabled="true"])` 设 `cursor: pointer`。基础层低于 design 组件层与 Tailwind
   utilities,组件 / 调用点显式写的光标(如 `cursor-default`、禁用态 `not-allowed`)照常覆盖。
2. **禁用控件不是手形**:选择器排除 `:disabled` / `aria-disabled="true"`(如搜索模式下禁用的设置分类按钮)。
3. **不波及文本区域**:规则只命中按钮语义元素,不含 `input` / `textarea` / `[contenteditable]` / 编辑器 / 终端。
