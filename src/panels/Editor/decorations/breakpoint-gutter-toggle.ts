// 点编辑器断点 gutter(行号左侧的红点列)切换该行断点(VSCode breakpointEditorContribution:左键单击 glyph margin 切换;
// 行号区仍是选中行)。已有红点 → 删除(含 adapter 校正到该行的断点),否则新增。断点记为窗口级用户断点(存到下次 launch),
// 并同步到本窗口的调试会话(见 DebugService.setUserBreakpoint)。只有能设断点的文件(JS / TS,canSetBreakpointsIn;VSCode
// debug.allowBreakpointsEverywhere 默认 false)gutter 才显示手形指针、点击才切换;其它文件(Markdown、JSON、CSS …)无操作。
// gutter 列本身由 debug-decorations 定义;这里在编辑器根元素上监听 mousedown(gutter 不在 contentDOM 里,
// EditorView.domEventHandlers 收不到),不改动它。BDD: src/__tests__/debug-user-controls/

import { EditorView, ViewPlugin } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { useDebugStore } from '@/stores/debug.store';
import { useEditorStore } from '@/stores/editor.store';
import { canSetBreakpointsIn } from '../../../../electron/shared/debug-view-channels';
import { findEditorFileTabById } from '../editor-tab-lookup';
import { breakpointLinesForTab } from './debug-decoration-sync';

/** 该 view 所属 tab 的第 line 行切换断点;不是文件 tab / 不能设断点的文件 → 无操作。 */
export function toggleBreakpointInView(view: EditorView, line: number): void {
  const editor = useEditorStore.getState();
  let tabId: string | null = null;
  for (const [id, ref] of editor.viewRefs) {
    if (ref === view) tabId = id;
  }
  const tab = tabId === null ? null : findEditorFileTabById(editor.tabs, tabId);
  if (!tab || !canSetBreakpointsIn(tab.filePath)) return;
  const debug = useDebugStore.getState();
  const present = breakpointLinesForTab(debug, tab).includes(line);
  void debug.setBreakpointAt(tab.filePath, line, !present);
}

const toggleOnGutterMouseDown = ViewPlugin.fromClass(
  class {
    constructor(private readonly view: EditorView) {
      view.dom.addEventListener('mousedown', this.onMouseDown);
    }

    destroy(): void {
      this.view.dom.removeEventListener('mousedown', this.onMouseDown);
    }

    private readonly onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      if (typeof target?.closest !== 'function' || target.closest('.cm-breakpoint-gutter') === null) return;
      const view = this.view;
      const block = view.lineBlockAtHeight(event.clientY - view.documentTop);
      event.preventDefault();
      toggleBreakpointInView(view, view.state.doc.lineAt(block.from).number);
    };
  },
);

const BREAKPOINTS_ALLOWED_CLASS = 'cm-breakpoints-allowed';

const breakpointGutterTheme = EditorView.baseTheme({
  [`&.${BREAKPOINTS_ALLOWED_CLASS} .cm-breakpoint-gutter`]: { cursor: 'pointer' },
});

/** filePath:该编辑器当前文件的路径(随重命名变化,每次更新重算是否可设断点)。 */
export function breakpointGutterToggle(filePath: () => string): Extension {
  return [
    toggleOnGutterMouseDown,
    breakpointGutterTheme,
    EditorView.editorAttributes.of(() => (canSetBreakpointsIn(filePath()) ? { class: BREAKPOINTS_ALLOWED_CLASS } : null)),
  ];
}
