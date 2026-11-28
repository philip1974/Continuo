// 菜单助记符(VSCode src/vs/base/common/labels.ts mnemonicMenuLabel;window.enableMenuBarMnemonics 默认开):catalog 里用 `&&` 标
// 助记符(「&&File」「文件(&&F)」,同 VSCode 与其中文 / 韩文语言包写法)。
// - Windows / Linux:`&&` → Electron 的助记符标记 `&`(Alt+F 打开「文件」);文本里本身的 `&` → `&&`(转义,显示为 `&`)。
// - macOS 没有助记符:去掉 `(&&X)` 与 `&&`,`&` 原样。
// BDD: src/__tests__/win-linux-parity/
import type { MenuItemConstructorOptions } from 'electron';

export function mnemonicMenuLabel(label: string, isMac: boolean): string {
  if (isMac) return label.replace(/\(&&\w\)|&&/g, '');
  return label.replace(/&&|&/g, (m) => (m === '&' ? '&&' : '&'));
}

/** 菜单模板里每个标签(含子菜单)按平台处理助记符。 */
export function applyMenuMnemonics(items: MenuItemConstructorOptions[], isMac: boolean): MenuItemConstructorOptions[] {
  return items.map((item) => {
    const submenu = Array.isArray(item.submenu) ? applyMenuMnemonics(item.submenu, isMac) : item.submenu;
    return {
      ...item,
      ...(item.label !== undefined ? { label: mnemonicMenuLabel(item.label, isMac) } : {}),
      ...(submenu !== undefined ? { submenu } : {}),
    };
  });
}
