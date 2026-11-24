// 可编辑元素原生右键菜单(剪切 / 复制 / 粘贴 / 全选),对齐 VSCode / Electron 常见做法。
// BDD:src/__tests__/edit-context-menu/。
//
// 与渲染层自定义菜单的分工:渲染层对 `contextmenu` DOM 事件 preventDefault() 后,webContents 不再发
// 'context-menu'(Electron 45.3.3 实测)—— Explorer 行(Radix ContextMenu)、终端自定义菜单据此不出双菜单。
import {
  Menu,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
} from 'electron';
import type { MainT } from './i18n';

type EditMenuParams = Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags'>;

/** 可编辑:四项(不可用置灰),全不可用 → 空;非可编辑有选区:只「复制」;否则空(不弹)。 */
function buildEditContextMenuTemplate(
  params: EditMenuParams,
  t: MainT,
): MenuItemConstructorOptions[] {
  const { editFlags } = params;
  const copy: MenuItemConstructorOptions = {
    role: 'copy',
    label: t('menu.edit.copy'),
    enabled: editFlags.canCopy,
  };
  if (params.isEditable) {
    if (!editFlags.canCut && !editFlags.canCopy && !editFlags.canPaste && !editFlags.canSelectAll) {
      return [];
    }
    return [
      { role: 'cut', label: t('menu.edit.cut'), enabled: editFlags.canCut },
      copy,
      { role: 'paste', label: t('menu.edit.paste'), enabled: editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: t('menu.edit.select_all'), enabled: editFlags.canSelectAll },
    ];
  }
  return params.selectionText !== '' && editFlags.canCopy ? [copy] : [];
}

/** 给窗口(主窗 / popout 子窗)挂右键菜单;文案每次右键时按当前语言取。 */
export function installEditContextMenu(win: BrowserWindow, getT: () => MainT): void {
  win.webContents.on('context-menu', (_event, params) => {
    const template = buildEditContextMenuTemplate(params, getT());
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}
