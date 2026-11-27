// 可编辑元素原生右键菜单(剪切 / 复制 / 粘贴 / 全选),对齐 VSCode / Electron 常见做法。
// 代码编辑器(CodeMirror:代码文件 / Markdown 源码模式)里右键 → VSCode 编辑器右键菜单:
//   [转到定义 F12 / ─](TS / JS,有语言服务时)/ 更改所有匹配项 ⌘F2 / 格式化文档 ⇧⌥F(有格式化程序时)/ ─ / 剪切 / 复制 / 粘贴 / ─ / 命令面板...
// (VSCode 编辑器右键菜单没有「全选」。)编辑器项点击 = 菜单命令(sendMenuCommand:popout 子窗 → 打开它的主窗执行,作用于该子窗),
// 键位显示同应用菜单(renderer 推送的生效键位)。是否代码编辑器由 renderer 在 DOM 上打的标记判定(见 shared/editor-context-menu)。
// BDD:src/__tests__/edit-context-menu/。
//
// 与渲染层自定义菜单的分工:渲染层对 `contextmenu` DOM 事件 preventDefault() 后,webContents 不再发
// 'context-menu'(Electron 45.3.3 实测)—— Explorer 行(Radix ContextMenu)、终端自定义菜单据此不出双菜单。
import {
  Menu,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebFrameMain,
} from 'electron';
import type { MainT } from './i18n';
import { sendMenuCommand } from './lib/menu-command';
import { menuAcceleratorOf } from './menu-keybindings';
import type { MenuCommandId } from '../shared/window-channels';
import {
  isEditorContextMenuKind,
  READ_EDITOR_CONTEXT_MENU_SCRIPT,
  type EditorContextMenuKind,
} from '../shared/editor-context-menu';

type EditMenuParams = Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags'>;

/** 编辑器项点击:执行菜单命令。 */
export type RunEditorMenuCommand = (id: MenuCommandId) => void;

/**
 * 可编辑:四项(不可用置灰),全不可用 → 空;非可编辑有选区:只「复制」;否则空(不弹)。
 * 代码编辑器(editorKind)→ VSCode 编辑器右键菜单的分组与顺序。
 */
export function buildEditContextMenuTemplate(
  params: EditMenuParams,
  t: MainT,
  editorKind: EditorContextMenuKind | null = null,
  run: RunEditorMenuCommand = () => undefined,
  acceleratorOf: (id: MenuCommandId) => string | undefined = (id) => menuAcceleratorOf(id),
): MenuItemConstructorOptions[] {
  const { editFlags } = params;
  const copy: MenuItemConstructorOptions = {
    role: 'copy',
    label: t('menu.edit.copy'),
    enabled: editFlags.canCopy,
  };
  if (params.isEditable && editorKind !== null) {
    const command = (id: MenuCommandId, label: string): MenuItemConstructorOptions => {
      const accelerator = acceleratorOf(id);
      return { id, label, ...(accelerator ? { accelerator, registerAccelerator: false } : {}), click: () => run(id) };
    };
    return [
      ...(editorKind === 'code-definition'
        ? [command('editor.action.revealDefinition', t('menu.editor_context.go_to_definition')), { type: 'separator' as const }]
        : []),
      command('editor.action.changeAll', t('menu.editor_context.change_all')),
      ...(editorKind === 'code-format'
        ? [command('editor.action.formatDocument', t('menu.editor_context.format_document'))]
        : []),
      { type: 'separator' },
      { role: 'cut', label: t('menu.edit.cut'), enabled: editFlags.canCut },
      copy,
      { role: 'paste', label: t('menu.edit.paste'), enabled: editFlags.canPaste },
      { type: 'separator' },
      command('workbench.action.showCommands', t('menu.editor_context.command_palette')),
    ];
  }
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

/** 在触发右键的 frame 里读出并清除代码编辑器标记;读不到(frame 已销毁 / 脚本失败)→ null(按普通可编辑元素)。 */
async function readEditorKind(frame: WebFrameMain | null | undefined): Promise<EditorContextMenuKind | null> {
  if (!frame) return null;
  try {
    const v: unknown = await frame.executeJavaScript(READ_EDITOR_CONTEXT_MENU_SCRIPT);
    return isEditorContextMenuKind(v) ? v : null;
  } catch {
    return null;
  }
}

/** 给窗口(主窗 / popout 子窗)挂右键菜单;文案每次右键时按当前语言取。 */
export function installEditContextMenu(win: BrowserWindow, getT: () => MainT): void {
  const popup = (params: ContextMenuParams, kind: EditorContextMenuKind | null) => {
    // 读标记期间窗口已关 → 不弹
    if (win.isDestroyed?.()) return;
    const run: RunEditorMenuCommand = (id) => void sendMenuCommand(win, id);
    const template = buildEditContextMenuTemplate(params, getT(), kind, run);
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  };
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable || !params.frame) {
      popup(params, null);
      return;
    }
    void readEditorKind(params.frame).then((kind) => popup(params, kind));
  });
}
