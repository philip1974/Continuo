# 强制颜色模式下的选中 / 高亮 / 按下状态

Windows 高对比度(CSS `forced-colors: active`)下浏览器把 `background-color` 改成 `Canvas`、边框 / 轮廓 / 文字改成
`CanvasText`、清空 `box-shadow`。只靠底色表达的状态(设置开关开 / 关、命令面板当前项、右键菜单键盘高亮、Explorer
选中行、dock / 编辑器活动 tab、终端搜索开关按下、设置导航当前项)全部消失;未选中项的透明占位边框反而每行都画成
`CanvasText` 竖条,看起来每项都被选中。

参考 VSCode 高对比度主题:选中 / 当前项画 `contrastActiveBorder` 轮廓、控件描边 `contrastBorder`;WCAG 1.4.11
(非文本对比度)/ 2.4.7(焦点可见)。

行为契约(`forced-colors.spec.ts`,CSS 契约 —— jsdom 不计算 media 规则,按源码钉规则;真实计算样式由 e2e
`tests/e2e/forced-colors-states.spec.ts` 用 `emulateMedia({ forcedColors: 'active' })` 验证):

1. **一处定义、按语义命中**:`src/styles/forced-colors.css` 的 `@media (forced-colors: active)` 给
   `[aria-selected="true"]`、`[aria-current]`(非 `false`)、`[aria-pressed="true"]`、`[data-highlighted]`、
   `[data-state="active|checked|on"]`、`[data-active="true"]` 画内嵌 2px `Highlight` 轮廓;选中项同时有键盘焦点时
   改虚线(与仅选中 / 仅焦点都可区分)。该文件以非 layer 方式在 design 之后导入,压过组件的 `outline: none`。
2. **透明占位边框不再显形**:强制颜色下 `.border-transparent` 改 `Canvas`;design 的 Tabs / SegmentedControl 未选中项
   透明边框改 `Canvas`,选中项改 `Highlight`(与同一元素上的轮廓重合成一圈)。TabNav(编辑器 tab)下划线一律 `Canvas`
   (含活动 tab):活动 tab 只由第 1 条的轮廓标记(VSCode 高对比度活动 tab 只一个 `contrastActiveBorder`)。
3. **只靠底色的指示条**:dock 活动 tab 顶部强调条(`[role="tab"] > .bg-accent`)、NavRailButton 激活条用
   `forced-color-adjust: none` + `Highlight`;TabNav 未保存圆点用 `CanvasText`。
4. **Switch 开 / 关可辨**:关 = `CanvasText` 描边 + `CanvasText` 滑块;开 = `Highlight` 轨道 + `HighlightText` 滑块
   (`forced-color-adjust: none` 让系统色生效),聚焦轮廓 `CanvasText`。
5. **MenuItem 原生聚焦 / 悬停**:`:focus-visible` 2px `Highlight` 实线,悬停 1px `Highlight` 虚线。
6. **正常模式零影响**:以上规则全部只在 `@media (forced-colors: active)` 内。
7. **每个选中项只一种标记**:语义状态属性只挂在一个元素上 —— 带状态属性的元素互不嵌套(旧 TabNav 外层 `data-active`
   + 内层 `aria-selected` 各画一圈,加上下划线成三重框)。`single-marker.spec.tsx` 渲染 TabNav / Tabs / SegmentedControl /
   NavRailButton 钉住;e2e 在强制颜色下扫描整个工作台(编辑器 tab、dock tab、设置导航、Explorer 行、活动栏)无嵌套命中。
