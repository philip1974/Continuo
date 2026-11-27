# 鼠标多光标修饰键对齐 VSCode(⌥ 单击添加光标)

此前代码编辑器沿用 CodeMirror 默认:⌘(Windows / Linux Ctrl)单击添加光标,⌥ 拖动 / ⌥ 单击是列选择 —— 已有多个光标时 ⌥ 单击
会清掉其它光标(被当成单点列选择)。VSCode `editor.multiCursorModifier` 默认 `alt`,与之相反。

1. **⌥ 单击添加光标**(Windows / Linux Alt 单击):在单击处新增一个光标,保留已有光标 / 选区;⌥ 拖动添加一段新选区
   (VSCode `_createCursor` / `_lastCursorMoveToSelect`)。只按 ⌥,同时按 ⇧ / ⌘ / Ctrl 时不算。
2. **⌘ / Ctrl 单击不添加光标**:普通单击(移动光标);留给打开链接 —— Markdown 源码模式里 ⌘ 单击链接跳转(`markdown-anchor-links`)
   不受影响(VSCode 中 ⌘ 单击 = 转到定义 / 打开链接)。
3. **列选择 = ⇧⌥ 拖动**(Windows / Linux Shift+Alt 拖动,VSCode multiCursorModifier=alt 时的列选择);只按 ⌥ 拖动不再是列选择。
   VSCode 的中键拖动列选择不做(Linux 中键是粘贴主选区)。
4. **不再显示十字光标**:CodeMirror 按住 ⌥ 时显示的十字光标是其列选择的提示,VSCode 没有 → 去掉。
5. 不加 `editor.multiCursorModifier` 设置(VSCode 可改为 ctrlCmd):先对齐默认,需要时再加。

## 规范

- `multicursor-modifier.spec.ts`:单击添加选区 / 列选择的修饰键判定、十字光标不出现、Markdown 链接 ⌘ 单击仍跳转
