// 按键是否落在打开的菜单(role="menu":Radix 右键菜单 / 自研 DropdownMenu)里。菜单开着时焦点在菜单内,按键由菜单处理,
// 工作台快捷键不在背后执行(对齐 VSCode 上下文菜单)。BDD: src/__tests__/hotkey-menu-suppression/
// 不用 instanceof Element:popout 子窗的节点属于子窗 realm,主窗的 Element 构造器认不出。
export function isInsideMenu(target: EventTarget | null | undefined): boolean {
  const el = target as Partial<Element> | null | undefined;
  return typeof el?.closest === 'function' && el.closest('[role="menu"]') !== null;
}
