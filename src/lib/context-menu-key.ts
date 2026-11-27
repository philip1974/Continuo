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

/**
 * 事件目标是否可编辑文本控件(input / textarea / select / contenteditable):这类元素上右键 / Shift+F10 留给原生编辑菜单
 *(main edit-context-menu),外层列表行的自定义菜单不接管(VSCode 设置项输入框里右键同样是剪切 / 复制 / 粘贴)。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}
