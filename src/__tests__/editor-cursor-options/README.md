# 编辑器光标样式 / 宽度 / 闪烁(VSCode editor.cursorStyle / cursorWidth / cursorBlinking)

行为契约:**代码编辑器、Markdown 源码模式与冲突比较的光标默认是 2px 竖线(此前 CodeMirror 默认 1.2px,屏幕共享 / 高分屏下
几乎看不见);设置页「编辑器」可改光标样式(竖线 / 块 / 下划线 / 细竖线 / 空心块 / 细下划线)、竖线宽度(0 = 默认 2px,最宽一个字符)、
闪烁方式(闪烁 / 平滑 / 渐隐 / 伸缩 / 不闪烁),改动即时生效。Markdown 编辑模式(原生光标)同步形状与是否闪烁。**

## 对照 VSCode

- `src/vs/editor/common/config/editorOptions.ts`:`cursorStyle`(line / block / underline / line-thin / block-outline /
  underline-thin,默认 line)、`cursorWidth`(默认 0,「cursorStyle 为 line 时的宽度」)、`cursorBlinking`(blink / smooth / phase /
  expand / solid,默认 blink)。
- `src/vs/editor/browser/viewParts/viewCursors/viewCursor.ts`:line 宽 = `cursorWidth > 0 ? cursorWidth : 2`,且不超过半角字符宽;
  line-thin 1px;block / block-outline / underline* 占一个字符宽,underline 2px、underline-thin 1px。
- `viewCursors.css`:smooth / phase / expand 关键帧(0.5s alternate);blink 亮 / 灭各 500ms;solid 不闪。

**刻意差异**:block 用差值混合反色显示光标下的字(VSCode 在光标里以背景色重画该字符;CodeMirror 光标层不含文字),强制颜色下画
CanvasText 实线框;闪烁不随光标移动重新开始;Markdown 编辑模式(ProseMirror 原生光标)只同步 `caret-shape`(竖线 / 块 / 下划线)
与 `caret-animation`(solid = 不闪烁),宽度与平滑类动画原生光标做不到。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/core-setting-specs.ts` | `EDITOR_CURSOR_STYLE` / `EDITOR_CURSOR_WIDTH` / `EDITOR_CURSOR_BLINKING`(编辑器 tab 外观组) |
| `src/panels/Editor/codemirror-cursor.ts` | `editorCursor(options)` CodeMirror 扩展、`lineCursorWidthPx`、`nativeCaretStyle`、`useEditorCursorOptions` |
| `src/panels/Editor/CodeEditor.tsx` / `ConflictDiffPanel.tsx` | 光标 Compartment,设置变化 reconfigure |
| `src/panels/Editor/MilkdownEditor.tsx` | 原生光标的 caret-shape / caret-animation |

## 规范文件

- `editor-cursor-options.spec.tsx`

## 关键行为

1. 三个设置:VSCode 同 id / 取值 / 默认值,编辑器 tab 注册,选项与说明三语。
2. 竖线宽度:cursorWidth 0 → 2px,n → npx(不超过 1ch);细竖线 1px;块类 / 下划线类 → 一个字符宽。
3. 真实 CodeMirror:默认光标规则是 2px(不再是 1.2px);block 反色;underline 2px 底边;闪烁周期 1000ms,solid → 0(不闪);
   smooth / phase / expand 用各自关键帧。
4. 代码编辑器与冲突比较经 Compartment 即时切换;Markdown 编辑模式 caret-shape:block* → block,underline* → underscore,其余 bar;
   solid → caret-animation: manual。

## e2e

`tests/e2e/presentation-mode.spec.ts`:代码编辑器光标 2px;改 cursorWidth 3 → 3px;改样式 underline → 2px 底边、无左边框。
