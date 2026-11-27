// e2e 读取页面里 CodeMirror 视图状态(.cm-content 的 tile 根 → EditorView;只读,不改状态)。
import type { Locator } from '@playwright/test';

export interface CmSelection {
  readonly anchor: number;
  readonly head: number;
  readonly text: string;
  readonly ranges: number;
  readonly headLine: number;
}

interface CmViewLike {
  state: {
    selection: { main: { anchor: number; head: number; from: number; to: number }; ranges: readonly unknown[] };
    doc: { lineAt(pos: number): { number: number } };
    sliceDoc(from: number, to: number): string;
  };
}

/** content = `.cm-content` 定位器(多个编辑器时先限定范围)。 */
export function cmSelection(content: Locator): Promise<CmSelection> {
  return content.evaluate((el) => {
    const view = (el as unknown as { cmTile: { root: { view: CmViewLike } } }).cmTile.root.view;
    const m = view.state.selection.main;
    return {
      anchor: m.anchor,
      head: m.head,
      text: view.state.sliceDoc(m.from, m.to),
      ranges: view.state.selection.ranges.length,
      headLine: view.state.doc.lineAt(m.head).number,
    };
  });
}
