// 无标题编辑器(VSCode untitled:⌘N 新建、未落盘的文本):tab 的 filePath / id 用 `untitled:Untitled-N` 这种不是磁盘路径的
// 标识(VSCode 同为 untitled: scheme)。renderer 显示名按界面语言(editor.untitled_name),main 的关窗脏确认按同一标识取编号。
// BDD: src/__tests__/editor-save-as/

export const UNTITLED_PREFIX = 'untitled:Untitled-';

/** `untitled:Untitled-<n>`(n ≥ 1 的整数)。 */
export function untitledPath(n: number): string {
  return `${UNTITLED_PREFIX}${String(n)}`;
}

/** 是无标题编辑器的标识(而不是磁盘路径)。 */
export function isUntitledPath(p: string): boolean {
  return untitledNumberOf(p) !== null;
}

/** 无标题编辑器的编号;不是无标题标识 → null。 */
export function untitledNumberOf(p: string): number | null {
  if (!p.startsWith(UNTITLED_PREFIX)) return null;
  const rest = p.slice(UNTITLED_PREFIX.length);
  if (!/^[1-9][0-9]{0,8}$/.test(rest)) return null;
  return Number(rest);
}
