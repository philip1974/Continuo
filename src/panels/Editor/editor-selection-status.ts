// 状态栏光标位置项的数据(VSCode status.editor.selection,editorStatus.ts):
// - 单个选区 → 「行 L，列 C」,有选中内容 → 「行 L，列 C (已选择N)」;多个选区 → 「N 选择」/「N 选择(已选择 M 个字符)」;
// - 行列取主选区的头(光标所在处);列按 tab 展开的可视列(CursorColumns.toStatusbarColumn:tab 跳到下一个 tabSize 制表位,
//   其余每个码点算 1);
// - 已选字符数 = 各选区码点数之和,换行按文件行尾计(CRLF 算 2;TextModel.getCharacterCountInRange)。
// CodeEditor 每次选区 / 内容 / tab 宽度变化时按「编辑器组 + tab」登记,卸载时移除;状态栏读主窗编辑器组的活动 tab。
// 纯数据 + store,只 import CodeMirror 的类型(状态栏在主 bundle)。BDD: src/__tests__/statusbar-editor-selection/

import { create } from 'zustand';
import type { EditorState } from '@codemirror/state';

export interface EditorSelectionStatus {
  /** 主选区头所在行(1 起)。 */
  readonly line: number;
  /** 主选区头的可视列(1 起,tab 按 tabSize 展开)。 */
  readonly col: number;
  /** 选区(光标)个数。 */
  readonly selections: number;
  /** 已选字符数(码点;换行按行尾长度)。 */
  readonly chars: number;
}

/** 行内 offset 处的状态栏列(CursorColumns.toStatusbarColumn):tab 跳到下一个制表位,其余每个码点算 1。 */
export function statusbarColumn(lineText: string, offset: number, tabSize: number): number {
  let col = 0;
  const end = Math.min(offset, lineText.length);
  for (let i = 0; i < end; i++) {
    const code = lineText.charCodeAt(i);
    if (code === 9) col = col + tabSize - (col % tabSize);
    else {
      col += 1;
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < end) i++;
    }
  }
  return col + 1;
}

/** 文本的码点数,`\n` 计 eolLength。 */
function countChars(text: string, eolLength: number): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10) n += eolLength;
    else {
      n += 1;
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) i++;
    }
  }
  return n;
}

export function selectionStatusOf(
  state: Pick<EditorState, 'doc' | 'selection' | 'tabSize' | 'sliceDoc'>,
  eolLength: number,
): EditorSelectionStatus {
  const { ranges, main } = state.selection;
  let chars = 0;
  for (const r of ranges) if (!r.empty) chars += countChars(state.sliceDoc(r.from, r.to), eolLength);
  const line = state.doc.lineAt(main.head);
  return {
    line: line.number,
    col: statusbarColumn(line.text, main.head - line.from, state.tabSize),
    selections: ranges.length,
    chars,
  };
}

interface SelectionStatusState {
  readonly byKey: ReadonlyMap<string, EditorSelectionStatus>;
}

const useSelectionStatusStore = create<SelectionStatusState>(() => ({ byKey: new Map() }));

const keyOf = (tabId: string, groupId: string): string => `${groupId}\u0000${tabId}`;

function same(a: EditorSelectionStatus | undefined, b: EditorSelectionStatus): boolean {
  return a !== undefined && a.line === b.line && a.col === b.col && a.selections === b.selections && a.chars === b.chars;
}

/** 登记某编辑器组里某 tab 的光标位置(相同则不动)。 */
export function setEditorSelectionStatus(tabId: string, groupId: string, status: EditorSelectionStatus): void {
  const key = keyOf(tabId, groupId);
  const { byKey } = useSelectionStatusStore.getState();
  if (same(byKey.get(key), status)) return;
  const next = new Map(byKey);
  next.set(key, status);
  useSelectionStatusStore.setState({ byKey: next });
}

/** 编辑器卸载:移除登记。 */
export function clearEditorSelectionStatus(tabId: string, groupId: string): void {
  const key = keyOf(tabId, groupId);
  const { byKey } = useSelectionStatusStore.getState();
  if (!byKey.has(key)) return;
  const next = new Map(byKey);
  next.delete(key);
  useSelectionStatusStore.setState({ byKey: next });
}

export function useEditorSelectionStatus(tabId: string, groupId: string): EditorSelectionStatus | undefined {
  return useSelectionStatusStore((s) => s.byKey.get(keyOf(tabId, groupId)));
}

/** 状态栏文案的 i18n key 与参数(editorStatus.getSelectionLabel)。 */
export function selectionStatusLabel(status: EditorSelectionStatus): {
  readonly key:
    | 'statusbar.selection.single'
    | 'statusbar.selection.single_range'
    | 'statusbar.selection.multi'
    | 'statusbar.selection.multi_range';
  readonly params: Readonly<Record<string, number>>;
} {
  if (status.selections === 1) {
    return status.chars > 0
      ? { key: 'statusbar.selection.single_range', params: { line: status.line, col: status.col, chars: status.chars } }
      : { key: 'statusbar.selection.single', params: { line: status.line, col: status.col } };
  }
  return status.chars > 0
    ? { key: 'statusbar.selection.multi_range', params: { count: status.selections, chars: status.chars } }
    : { key: 'statusbar.selection.multi', params: { count: status.selections } };
}
