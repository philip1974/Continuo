// 应用菜单项即 renderer 命令(MENU_COMMANDS,如 文件 → 打开文件夹… ⌘O):main 发 RUN_MENU_COMMAND,这里经命令注册表执行。
// BDD: src/__tests__/explorer-commands/(第 5 条)

import { useEffect } from 'react';
import { coApi } from '@/lib/co-api';
import { tWithFallback } from '@/i18n';
import { hasOpenModalIn } from '@/design/Modal';
import { isInsideMenu } from '@/lib/menu-focus';
import { runRegisteredCommand } from '@/lib/run-contributed-action';
import type { CommandRegistry } from '@/plugins/registries/CommandRegistry';
import { getPopoutDocuments } from '@/shell/dock/popout-documents';
import { isMenuCommandId } from '../../electron/shared/window-channels';

/**
 * 只认登记过的菜单命令;任一文档(主窗 / popout 子窗)有 Modal 打开、或焦点在打开的菜单里时不执行(与工作台快捷键一致,
 * 对齐 VSCode)。菜单开着时 renderer 分发不 preventDefault,⌘O 等键会落到应用菜单 accelerator 再经这里执行。
 */
export function runMenuCommand(commands: CommandRegistry, id: unknown): void {
  if (!isMenuCommandId(id)) return;
  const blocked = (doc: Document) => hasOpenModalIn(doc) || isInsideMenu(doc.activeElement);
  if (blocked(document) || getPopoutDocuments().some(blocked)) return;
  const spec = commands.get(id);
  runRegisteredCommand(commands, id, spec ? tWithFallback(spec.titleKey, spec.title) : id);
}

export function useMenuCommands(commands: CommandRegistry): void {
  useEffect(() => coApi.window.onMenuCommand((id) => runMenuCommand(commands, id)), [commands]);
}
