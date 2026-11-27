// 保存冲突差异 tab(VSCode「Compare」打开的 save conflict 差异编辑器)的 dock 面板 type / id / params。
// 单独成文件:strip-terminal-layout(布局持久化剥离)与 EditorPlugin(注册面板)只需这些常量,不拉入差异视图 chunk。
// BDD: src/__tests__/editor-save-conflict-compare/

/** dock 面板 type(= contentComponent)。 */
export const CONFLICT_DIFF_PANEL_TYPE = 'conflict-diff';

/** 每个文档至多一个差异 tab:id 由文档 tab id 派生,再次「比较」同一文件只激活已有的。 */
export function conflictDiffPanelId(tabId: string): string {
  return `${CONFLICT_DIFF_PANEL_TYPE}:${tabId}`;
}

/** 差异 tab 标题(三语,随语言切换:useDockLocaleSync 按 titleKey + titleArgs 重算)。 */
export const CONFLICT_DIFF_TITLE_KEY = 'panels.editor.conflict_diff.title';

/** 差异 tab 的 dock params。 */
export interface ConflictDiffParams {
  /** 右侧「你的版本」所属的文档 tab(编辑器 store 的 tab id)。 */
  readonly tabId: string;
  /** 从哪个编辑器组打开:接受 / 放弃后回到该组里的原 tab。 */
  readonly groupId: string;
  readonly titleKey: typeof CONFLICT_DIFF_TITLE_KEY;
  readonly titleArgs: { readonly name: string };
}

/** 面板 params 是差异 tab 的 → 返回它;否则 null(面板不是差异 tab / params 畸形)。 */
export function conflictDiffParamsOf(panel: {
  readonly view?: { readonly contentComponent?: string } | undefined;
  readonly params?: unknown;
}): ConflictDiffParams | null {
  if (panel.view?.contentComponent !== CONFLICT_DIFF_PANEL_TYPE) return null;
  const p = panel.params as Partial<ConflictDiffParams> | undefined;
  if (!p || typeof p.tabId !== 'string' || typeof p.groupId !== 'string') return null;
  return p as ConflictDiffParams;
}
