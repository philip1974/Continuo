# 色觉差异 / 强制颜色下的非颜色线索

色觉差异(红绿色盲等)与 Windows 高对比度(CSS `forced-colors: active`:背景色被抹成 `Canvas`、文字 / 边框改 `CanvasText`)
下,只靠颜色或只靠 `background-color` 表达的信息会丢失(WCAG 1.4.1 使用颜色、1.4.11 非文本对比度)。对照 VSCode:
codicon 字形(前景色)代替纯色块、高对比度主题改画 contrastBorder / contrastActiveBorder 轮廓、差异编辑器 `renderIndicators`。

行为契约(jsdom 不计算 media 规则:按 CodeMirror 注入的主题 CSS / 渲染出的 DOM 钉契约;真实计算样式由 e2e
`tests/e2e/color-vision-cues.spec.ts` 在 CDP `emulateMedia({ forcedColors: 'active' })` 下核对):

1. **调试装饰**(`debug-decorations.ts`;VSCode 断点 / 执行箭头是 codicon 字形):强制颜色下 `forced-color-adjust: none` +
   系统色 —— 断点红点 `CanvasText`、执行箭头 `Highlight`、箭头里的断点红点 `HighlightText`,执行行 1px `Highlight` 轮廓。
   正常模式下箭头里的红点外描一圈画布色(红 / 黄两色亮度接近,色盲下难分)。
2. **编辑器出现处 / 括号 / 缩进参考线**(`code-editor-theme.ts`,VSCode HC `editor.selectionHighlightBorder` dotted、
   `editorBracketMatch.border` 实线):强制颜色下 `.cm-selectionMatch` 1px 点线 `CanvasText`、`.cm-matchingBracket` 1px 实线
   `CanvasText`;缩进参考线普通 `GrayText`、当前块 `CanvasText`(保住渐变)。@media 块里的规则都挂在主题类下(不出现
   `@media (…).cm-…` 这种把 at-rule 当选择器前缀的无效规则 —— EditorView.theme 在 @media 里不支持 `&`)。
3. **toast 等级图标**(VSCode 通知 codicon error / warning / info;success 圆圈对勾):每个等级一个形状不同的 SVG
   (描边 `currentColor`,`aria-hidden`),替代只靠颜色区分的 6px 实心圆点。
4. **调试控制台**:见 `debug-user-controls`(stderr 实线 / console 虚线左竖条)。**调用栈不可打开的帧**:见
   `51-debug-breakpoint-ui`(非按钮、斜体、不叠透明度)。**授权弹窗风险说明**:见 `agent-auth-prompt`(12px 正文色 + 警告图标)。
   **冲突比较 `−` / `+` 指示符**:见 `editor-save-conflict-compare`。
5. **暗色终端最低对比度**:xterm `minimumContrastRatio` 暗色 4.5(VSCode `terminal.integrated.minimumContrastRatio` 默认值,
   各主题同为 4.5),亮色保留 7(issue #24 刻意更严);构造与主题切换同一取值。
6. **关键 token 组合对比度**:见 `design-system/contrast.spec.ts`(语法色叠当前行 / 执行行 / 选区、执行箭头、占位符)。
