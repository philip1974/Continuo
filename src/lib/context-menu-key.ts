// 键盘打开右键菜单:Shift+F10 / 菜单键(Windows / Linux 约定,mac 上同样可用;VSCode 同)。
// 终端(terminal-hotkeys)与 tab 右键菜单共用。

export interface ContextMenuKeyLike {
  readonly type: string;
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
}

export function isContextMenuKey(event: ContextMenuKeyLike): boolean {
  if (event.type !== 'keydown' || event.isComposing === true) return false;
  if (event.key === 'ContextMenu') return true;
  return event.key === 'F10' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** 在元素左下角派发 contextmenu(Radix ContextMenu 按事件坐标定位菜单)。 */
export function dispatchContextMenuAt(el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom }));
}
