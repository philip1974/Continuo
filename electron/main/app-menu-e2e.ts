// e2e 专用(仅 CONTINUO_E2E=1):E2E 模式下应用菜单为 null(Electron 默认菜单的 ⌘P = Print 会吞 Quick Open),Playwright 也点不到
// 原生菜单。经 globalThis 暴露同一份菜单模板:读结构 / accelerator,按下标路径调用菜单项的 click(与真实点击同一路径:
// sendMenuCommand → 获焦窗口的主窗 renderer)。BDD: src/__tests__/app-menu-bar/、e2e: tests/e2e/app-menu-bar.spec.ts

import { BrowserWindow, type KeyboardEvent, type MenuItemConstructorOptions } from 'electron';

/** 模板节点的可序列化快照(Playwright evaluate 只能回传 JSON)。 */
export interface MenuSnapshotItem {
  readonly id?: string;
  readonly label?: string;
  readonly role?: string;
  readonly type?: string;
  readonly checked?: boolean;
  readonly accelerator?: string;
  readonly registerAccelerator?: boolean;
  readonly submenu?: readonly MenuSnapshotItem[];
}

export interface AppMenuE2eHook {
  snapshot(): MenuSnapshotItem[];
  /** 按下标路径点击菜单项,win = 该 id 的窗口(模拟它获焦);返回是否找到可点击的项。 */
  click(path: readonly number[], windowId: number, triggeredByAccelerator?: boolean): boolean;
}

function snapshotOf(items: readonly MenuItemConstructorOptions[]): MenuSnapshotItem[] {
  return items.map((m) => ({
    ...(m.id === undefined ? {} : { id: m.id }),
    ...(m.label === undefined ? {} : { label: m.label }),
    ...(m.role === undefined ? {} : { role: m.role }),
    ...(m.type === undefined ? {} : { type: m.type }),
    ...(m.checked === undefined ? {} : { checked: m.checked }),
    ...(typeof m.accelerator === 'string' ? { accelerator: m.accelerator } : {}),
    ...(m.registerAccelerator === undefined ? {} : { registerAccelerator: m.registerAccelerator }),
    ...(Array.isArray(m.submenu) ? { submenu: snapshotOf(m.submenu) } : {}),
  }));
}

export function installAppMenuE2eHook(template: () => MenuItemConstructorOptions[]): void {
  if (process.env['CONTINUO_E2E'] !== '1') return;
  const hook: AppMenuE2eHook = {
    snapshot: () => snapshotOf(template()),
    click: (path, windowId, triggeredByAccelerator = false) => {
      let items: readonly MenuItemConstructorOptions[] = template();
      let item: MenuItemConstructorOptions | undefined;
      for (const i of path) {
        item = items[i];
        items = Array.isArray(item?.submenu) ? item.submenu : [];
      }
      if (!item?.click) return false;
      const win = BrowserWindow.fromId(windowId) ?? undefined;
      item.click(item as never, win, { triggeredByAccelerator } as KeyboardEvent);
      return true;
    },
  };
  (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu = hook;
}
