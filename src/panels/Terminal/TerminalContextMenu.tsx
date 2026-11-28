// 终端右键菜单(对齐 VSCode 终端右键菜单):拆分终端(Create 组,带键位)/ 复制(有选区才可用)/ 粘贴 / 全选 / 清除终端。
// 写法同 Explorer ContextMenu:Radix ContextMenu + design MenuItem(asChild)。终端不是可编辑元素,不走主进程通用编辑菜单。
// 键盘 Shift+F10 / 菜单键由 useTerminal 在光标处派发 contextmenu 打开。
// BDD: src/__tests__/terminal-vscode-parity/

import * as Menu from '@radix-ui/react-context-menu';
import { useRef, useState, type ReactNode } from 'react';
import { MenuItem } from '@/design';
import { useT } from '@/i18n';
import { CONTEXT_MENU_CONTENT_CLASS_NAME } from '@/lib/menu-surface';
import { useRegisteredCommandHotkeyText } from '@/lib/hotkey-label';
import { coApp } from '@/plugins/co-app';
import { TERMINAL_SPLIT_COMMAND_ID } from './terminal-hotkeys';

export interface TerminalContextMenuActions {
  readonly hasSelection: () => boolean;
  readonly copy: () => void;
  readonly paste: () => void;
  readonly selectAll: () => void;
  readonly clear: () => void;
  /** 菜单关闭后焦点回到终端(触发区本身不可聚焦)。 */
  readonly focus: () => void;
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
  /** 拆分终端(在本终端旁新建,见 shell/dock/terminal-split)。 */
  onSplit: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const splitShortcut = useRegisteredCommandHotkeyText(coApp.commands, TERMINAL_SPLIT_COMMAND_ID);
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
        onContextMenu={(e) => setPortalHost(e.currentTarget.ownerDocument.body)}
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
              onSplit();
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
          <Item onSelect={actions.clear}>{t('commands.terminal.clear.title')}</Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
