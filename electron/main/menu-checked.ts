// 应用菜单勾选项的状态(如 文件 → 自动保存;VSCode 菜单项 toggled 条件由渲染进程的上下文键求值)。设置值在 renderer
//(localStorage,跨窗同步),renderer 推送勾选状态,这里记下供菜单模板读取;有变化才重建菜单。
// BDD: src/__tests__/files-auto-save/

import { isMenuCheckboxId, type MenuCheckboxId } from '../shared/window-channels';

let current: ReadonlyMap<MenuCheckboxId, boolean> = new Map();

/** 记下 renderer 推送的勾选状态(整表替换;未登记的 id / 非布尔值忽略)。返回是否有变化。 */
export function setMenuChecked(raw: Readonly<Record<string, unknown>>): boolean {
  const next = new Map<MenuCheckboxId, boolean>();
  for (const [id, checked] of Object.entries(raw)) {
    if (isMenuCheckboxId(id) && typeof checked === 'boolean') next.set(id, checked);
  }
  const changed = next.size !== current.size || [...next].some(([id, v]) => current.get(id) !== v);
  current = next;
  return changed;
}

/** 勾选项当前是否勾选(未推送 → false)。 */
export function menuCheckedOf(id: MenuCheckboxId): boolean {
  return current.get(id) === true;
}
