// 编辑器组的读屏组号(对齐 VSCode:多个编辑器组时编辑器名称「<文件名>, Editor Group N」)。useDockLocaleSync 按与
// dock 标题「编辑器 N」同一来源(editorGroupNumbers,空间顺序)发布;所在窗口只有一个编辑器组 → 不发布(名称不带组号)。
// BDD: src/__tests__/editor-accessible-name/

import { create } from 'zustand';

const useNumbers = create<{ readonly numbers: ReadonlyMap<string, number> }>(() => ({ numbers: new Map() }));

/** 发布各组的组号(只含所在窗口有多个编辑器组的组);内容不变则不通知。 */
export function publishEditorGroupNumbers(numbers: ReadonlyMap<string, number>): void {
  const prev = useNumbers.getState().numbers;
  if (prev.size === numbers.size && [...numbers].every(([id, n]) => prev.get(id) === n)) return;
  useNumbers.setState({ numbers: new Map(numbers) });
}

/** 组 groupId 的读屏组号;所在窗口只有一个编辑器组 → undefined。 */
export function useEditorGroupNumber(groupId: string): number | undefined {
  return useNumbers((s) => s.numbers.get(groupId));
}
