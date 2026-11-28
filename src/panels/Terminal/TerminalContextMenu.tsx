// 终端右键菜单(对齐 VSCode 终端右键菜单):拆分终端(Create 组,带键位)/ 复制(有选区才可用)/ 粘贴 / 全选 / 清除终端。
// 写法同 Explorer ContextMenu:Radix ContextMenu + design MenuItem(asChild)。终端不是可编辑元素,不走主进程通用编辑菜单。
// 键盘 Shift+F10 / 菜单键由 useTerminal 在光标处派发 contextmenu 打开。
// 右键行为按平台对齐 VSCode terminal.integrated.rightClickBehavior 默认值(`isMacintosh ? 'selectWord' : isWindows ? 'copyPaste' : 'default'`):
// Windows 右键 = 有选区复制并清除选区、没有选区粘贴,不弹菜单(Shift+右键仍弹菜单,同 VSCode handleMouseEvent);mac 右键选词 + 菜单
//(xterm rightClickSelectsWord 默认 mac 开)、Linux 弹菜单。BDD: src/__tests__/win-linux-parity/
// BDD: src/__tests__/terminal-vscode-parity/

import * as Menu from '@radix-ui/react-context-menu';
import { useRef, useState, type ReactNode } from 'react';
import { MenuItem } from '@/design';
import { useT } from '@/i18n';
import { CONTEXT_MENU_CONTENT_CLASS_NAME } from '@/lib/menu-surface';
import { useRegisteredCommandHotkeyText } from '@/lib/hotkey-label';
import { coApp } from '@/plugins/co-app';
import { detectTerminalOs, TERMINAL_CLEAR_COMMAND, TERMINAL_SPLIT_COMMAND_ID, type TerminalOs } from './terminal-hotkeys';

export interface TerminalContextMenuActions {
  readonly hasSelection: () => boolean;
  readonly copy: () => void;
  readonly paste: () => void;
  readonly selectAll: () => void;
  readonly clearSelection: () => void;
  readonly clear: () => void;
  /** 菜单关闭后焦点回到终端(触发区本身不可聚焦)。 */
  readonly focus: () => void;
}

/**
 * 这次 contextmenu 是否按 Windows 的 copyPaste 处理(VSCode rightClickBehavior 默认:仅 Windows):鼠标右键(button 2)且没按 Shift;
 * 键盘打开(Shift+F10 / 菜单键,button 0)与 Shift+右键照常弹菜单。
 */
export function isTerminalRightClickCopyPaste(event: Pick<MouseEvent, 'button' | 'shiftKey'>, os: TerminalOs = detectTerminalOs()): boolean {
  return os === 'windows' && event.button === 2 && !event.shiftKey;
}

function Item({
  onSelect,
  disabled,
  shortcut,
  children,
}: {
  onSelect: () => void;
  disabled?: boolean;
  shortcut?: string;
  children: ReactNode;
}) {
  return (
    <Menu.Item asChild onSelect={onSelect} disabled={disabled}>
      <MenuItem disabled={disabled} shortcut={shortcut}>
        {children}
      </MenuItem>
    </Menu.Item>
  );
}

export function TerminalContextMenu({
  actions,
  onSplit,
  children,
}: {
  actions: TerminalContextMenuActions;
  /** 拆分终端(在本终端旁新建,见 shell/dock/terminal-split);resolve 新终端 id,失败 null。 */
  onSplit: () => Promise<string | null>;
  children: ReactNode;
}) {
  const t = useT();
  const splitShortcut = useRegisteredCommandHotkeyText(coApp.commands, TERMINAL_SPLIT_COMMAND_ID);
  // 「清除终端」右侧键位(VSCode 终端右键同显示 ⌘K;Windows / Linux 默认未绑定不显示),改键跟随
  const clearShortcut = useRegisteredCommandHotkeyText(coApp.commands, TERMINAL_CLEAR_COMMAND.id);
  // 选了「拆分终端」:焦点要进新终端,关闭菜单时不把焦点交回本终端(否则本终端所在组重新变成活动组,新终端挂载时不再获焦)。
  const keepFocusAwayRef = useRef(false);
  // 打开时取一次:选区(mac 右键按下即选词,早于 contextmenu)与 portal 目标文档(popout 子窗的终端菜单画在子窗)。
  const [hasSelection, setHasSelection] = useState(false);
  const [portalHost, setPortalHost] = useState<HTMLElement | undefined>(undefined);
  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) setHasSelection(actions.hasSelection());
      }}
    >
      <Menu.Trigger
        asChild
        onContextMenu={(e) => {
          if (isTerminalRightClickCopyPaste(e)) {
            // preventDefault:Radix 不再打开菜单(composeEventHandlers 见 defaultPrevented 即跳过)。
            e.preventDefault();
            if (actions.hasSelection()) {
              actions.copy();
              actions.clearSelection();
            } else {
              actions.paste();
            }
            return;
          }
          setPortalHost(e.currentTarget.ownerDocument.body);
        }}
      >
        {children}
      </Menu.Trigger>
      <Menu.Portal container={portalHost}>
        <Menu.Content
          className={CONTEXT_MENU_CONTENT_CLASS_NAME}
          collisionPadding={8}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (keepFocusAwayRef.current) keepFocusAwayRef.current = false;
            else actions.focus();
          }}
        >
          <Item
            onSelect={() => {
              keepFocusAwayRef.current = true;
              // 拆分失败(新建被拒 / 无工作区时取消选文件夹…):没有新终端接焦点 → 还给本终端,不掉到 body;
              // 期间焦点已去了别处(用户点了别的地方 / 弹出的对话框)则不抢。
              const doc = portalHost?.ownerDocument ?? document;
              const refocus = () => {
                if (!doc.activeElement || doc.activeElement === doc.body) actions.focus();
              };
              onSplit().then((id) => {
                if (id === null) refocus();
              }, refocus);
            }}
            shortcut={splitShortcut}
          >
            {t('commands.terminal.split.title')}
          </Item>
          <Menu.Separator className="my-1 h-px bg-line" />
          <Item onSelect={actions.copy} disabled={!hasSelection}>
            {t('panels.terminal.ctx.copy')}
          </Item>
          <Item onSelect={actions.paste}>{t('panels.terminal.ctx.paste')}</Item>
          <Item onSelect={actions.selectAll}>{t('panels.terminal.ctx.select_all')}</Item>
          <Menu.Separator className="my-1 h-px bg-line" />
          <Item onSelect={actions.clear} shortcut={clearShortcut}>
            {t('commands.terminal.clear.title')}
          </Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
