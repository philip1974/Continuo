// 编辑器组(多实例编辑器 dock 面板)的 id 约定,renderer 与持久化 schema 共用(BDD: src/__tests__/editor-groups/)。
//
// 第一个组沿用历史单例面板 id `editor`;拆分出的组为 `editor:2`、`editor:3`…(dock 面板 id = 组 id)。

/** 第一个编辑器组(历史单例编辑器面板)的 id。 */
export const PRIMARY_EDITOR_GROUP_ID = 'editor';

/** 编辑器组 id 的形态:`editor` 或 `editor:<正整数>`。 */
export const EDITOR_GROUP_ID_RE = /^editor(?::[1-9]\d{0,3})?$/;

/** 同时存在的编辑器组上限(拆分到上限后不再新建组;持久化 schema 同一上限)。 */
export const EDITOR_GROUPS_MAX = 16;

export function isEditorGroupId(id: string): boolean {
  return EDITOR_GROUP_ID_RE.test(id);
}

/** 不与 taken 中任何 id 重复的下一个组 id(`editor:2` 起)。 */
export function nextEditorGroupId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 2; ; n++) {
    const id = `${PRIMARY_EDITOR_GROUP_ID}:${n}`;
    if (!used.has(id)) return id;
  }
}
