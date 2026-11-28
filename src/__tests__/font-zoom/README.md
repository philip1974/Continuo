# 放大 / 缩小编辑器与终端字体(VSCode fontZoom 命令 + mouseWheelZoom)

行为契约:**「放大 / 缩小 / 重置编辑器字体」临时缩放所有编辑器(代码编辑器、Markdown 源码 / 编辑模式、冲突比较,主窗与 popout
子窗)的字号与行高,不改设置、重启后恢复;「终端: 放大 / 缩小 / 重置字体大小」直接改设置 `terminal.integrated.fontSize`(所有终端、
重启保持)。打开 `editor.mouseWheelZoom` / `terminal.integrated.mouseWheelZoom` 后,按住 ⌘(Windows / Linux Ctrl)滚动鼠标滚轮
同样缩放。都没有默认键。**

## 对照 VSCode

- `src/vs/editor/contrib/fontZoom/browser/fontZoom.ts`:`editor.action.fontZoomIn` / `fontZoomOut` / `fontZoomReset`
  (Increase / Decrease / Reset Editor Font Size,无分类、无默认键)→ `EditorZoom.setZoomLevel(level ± 1 / 0)`。
- `src/vs/editor/common/config/editorZoom.ts`:全局内存态级别,夹在 [-5, 20],**不写设置**。
- `src/vs/editor/common/config/fontInfo.ts`:字号与行高 × `(1 + level × 0.1)`。
- `src/vs/editor/common/config/editorOptions.ts`:`editor.mouseWheelZoom`(默认 false;mac 按 Cmd,其它 Ctrl)。
- `src/vs/workbench/contrib/terminalContrib/zoom/browser/terminal.zoom.contribution.ts`:终端 `fontZoomIn` / `Out` / `Reset`
  改 `terminal.integrated.fontSize`(±1,夹到 6..100;重置 = 默认值);`terminal.integrated.mouseWheelZoom`;滚轮修饰键
  `_hasMouseWheelZoomModifiers`(mac:⌘ 或 ⌃(捏合)且无 ⇧ / ⌥;其它:只 Ctrl)。

**刻意差异**:终端字号夹在本项目该设置的范围 10..24(设置页同一范围);滚轮不区分物理滚轮与触控板(VSCode MouseWheelClassifier):
按行滚动或单次 ≥ 50px = ±1 级,更小的像素增量累计满 50px 再 ±1(停顿 > 200ms 重新累计)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/editor-font-zoom.ts` | 缩放级别 store、倍率、`useEditorFontSize` / `useEditorFontStyle` / `useEditorMouseWheelZoom`、命令 spec |
| `src/panels/Terminal/terminal-font-zoom.ts` | `stepTerminalFontSize` / `resetTerminalFontSize`、`useTerminalMouseWheelZoom`、命令 spec |
| `src/lib/mouse-wheel-zoom.ts` | 修饰键判定与滚轮累计 |

## 规范文件

- `font-zoom.spec.tsx`

## 关键行为

1. 编辑器命令三条:无默认键、无分类、三语标题;EditorPlugin 注册。级别 ±1,夹在 [-5, 20],重置 0;不写 `editor.fontSize`。
2. 生效字号 = 设置字号 × (1 + 0.1 × 级别)(13 → 14.3);设置了行高时行高同样放大(写在编辑器容器上);代码编辑器 / Markdown /
   冲突比较都用它。
3. 终端命令三条:分类「终端」;±1 写设置并夹在 [10, 24];重置删掉覆盖。
4. 滚轮:设置打开才挂;按住修饰键向上滚放大、向下缩小并 preventDefault;不按 / 多按 ⇧ ⌥ 不处理;小增量累计。
5. 两个设置默认关,三语文案。

## e2e

`tests/e2e/presentation-mode.spec.ts`:命令面板「放大编辑器字体」→ 编辑器 13px → 14.3px,设置未变;重置回 13px。
