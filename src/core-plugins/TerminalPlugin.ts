// xterm 全套走 lazy chunk,Terminal panel 没打开时不下载。

import { lazy } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';
import type { TerminalPanelViewParams } from '@/panels/Terminal/TerminalPanelView';
import { createUserTerminal } from '@/shell/dock/create-user-terminal';
import { getDockApi } from '@/shell/dock/dock-api-ref';
import { activePanelInDocument } from '@/shell/dock/group-mru';
import { getCommandDocument } from '@/shell/dock/popout-documents';
import { toggleActiveTerminalZoom } from '@/shell/dock/terminal-panel-zoom';
import { toggleTerminal } from '@/shell/dock/toggle-terminal';
import { clearTerminalPanel, openTerminalSearch } from '@/panels/Terminal/terminal-panel-handles';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import {
  TERMINAL_CLEAR_COMMAND,
  TERMINAL_SEARCH_COMMAND,
  TERMINAL_TOGGLE_COMMAND,
  TERMINAL_ZOOM_COMMAND,
  terminalClearDefaultHotkey,
} from '@/panels/Terminal/terminal-hotkeys';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';

const TerminalPanelView = lazy(() =>
  import('@/panels/Terminal/TerminalPanelView').then((m) => ({
    default: m.TerminalPanelView,
  })),
);

export default class TerminalPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: TERMINAL_PANEL_TYPE,
      title: 'Terminal',
      titleKey: 'panels.terminal.title',
      multiInstance: true,
      factory: lazyPanel<IDockviewPanelProps<TerminalPanelViewParams>>(
        TerminalPanelView,
      ),
    });
    this.addCommand({
      id: TERMINAL_ZOOM_COMMAND.id,
      title: 'Toggle Terminal Zoom',
      titleKey: 'commands.terminal.zoom.title',
      category: 'Terminal',
      categoryKey: 'commands.terminal.category',
      hotkey: TERMINAL_ZOOM_COMMAND.hotkey,
      fn: () => {
        const api = getDockApi();
        if (!api) return;
        toggleActiveTerminalZoom(api);
      },
    });
    this.addCommand({
      id: TERMINAL_SEARCH_COMMAND.id,
      title: 'Find in Terminal',
      // i18n(I17):补 titleKey,命令面板/快捷键设置经 tk(titleKey, title) 渲染本地化
      titleKey: 'commands.terminal.search.title',
      category: 'Terminal',
      categoryKey: 'commands.terminal.category',
      hotkey: TERMINAL_SEARCH_COMMAND.hotkey,
      fn: () => {
        // 作用于触发窗口的活动面板(主窗按键 / 命令面板时活动组可能仍在 popout 子窗)
        const api = getDockApi();
        const active = api && activePanelInDocument(api, getCommandDocument());
        if (!active || active.view.contentComponent !== TERMINAL_PANEL_TYPE) return;
        openTerminalSearch(active.id);
      },
    });
    // VSCode workbench.action.terminal.clear(mac ⌘K;Win/Linux 无默认键,Ctrl+K 留给 shell):清空活动终端的屏幕与
    // 滚动缓冲;活动面板不是终端 → no-op。
    this.addCommand({
      id: TERMINAL_CLEAR_COMMAND.id,
      title: 'Clear Terminal',
      titleKey: 'commands.terminal.clear.title',
      category: 'Terminal',
      categoryKey: 'commands.terminal.category',
      hotkey: terminalClearDefaultHotkey(detectPlatform()),
      fn: () => {
        const api = getDockApi();
        const active = api && activePanelInDocument(api, getCommandDocument());
        if (!active || active.view.contentComponent !== TERMINAL_PANEL_TYPE) return;
        clearTerminalPanel(active.id);
      },
    });
    this.addCommand({
      id: 'terminal.new',
      title: 'New Terminal',
      titleKey: 'commands.terminal.new.title',
      category: 'Terminal',
      categoryKey: 'commands.terminal.category',
      hotkey: 'mod+t',
      // 可维护性 M1:终端创建流程抽到 createUserTerminal(与 Dock header 新建入口共用)。
      fn: () => createUserTerminal().then(() => undefined),
    });
    // VSCode workbench.action.terminal.toggleTerminal(各平台 ⌃`):焦点不在终端 → 最近使用的终端(没有则新建);在终端 → 回到编辑器。
    // BDD: src/__tests__/terminal-toggle/
    this.addCommand({
      ...TERMINAL_TOGGLE_COMMAND,
      title: 'Toggle Terminal',
      titleKey: 'commands.terminal.toggle.title',
      category: 'View',
      categoryKey: 'commands.view.category',
      fn: toggleTerminal,
    });
  }
}
