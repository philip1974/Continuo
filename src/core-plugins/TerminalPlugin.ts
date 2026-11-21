// xterm 全套走 lazy chunk,Terminal panel 没打开时不下载。

import { lazy } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';
import type { TerminalPanelViewParams } from '@/panels/Terminal/TerminalPanelView';
import { createUserTerminal } from '@/shell/dock/create-user-terminal';
import { getDockApi } from '@/shell/dock/dock-api-ref';
import { toggleActiveTerminalZoom } from '@/shell/dock/terminal-panel-zoom';
import { openTerminalSearch } from '@/panels/Terminal/terminal-search-registry';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';

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
      factory: lazyPanel<IDockviewPanelProps<TerminalPanelViewParams>>(
        TerminalPanelView,
      ),
    });
    this.addCommand({
      id: 'terminal.zoom.toggle',
      title: 'Toggle Terminal Zoom',
      titleKey: 'commands.terminal.zoom.title',
      category: 'Terminal',
      categoryKey: 'commands.terminal.category',
      hotkey: 'shift+mod+enter',
      fn: () => {
        const api = getDockApi();
        if (!api) return;
        toggleActiveTerminalZoom(api);
      },
    });
    this.addCommand({
      id: 'terminal.search.toggle',
      title: 'Find in Terminal',
      // i18n(I17):补 titleKey,命令面板/快捷键设置经 tk(titleKey, title) 渲染本地化
      titleKey: 'commands.terminal.search.title',
      category: 'Terminal',
      categoryKey: 'commands.terminal.category',
      hotkey: 'mod+f',
      fn: () => {
        const api = getDockApi();
        const active = api?.activePanel;
        if (!active || active.view.contentComponent !== TERMINAL_PANEL_TYPE) return;
        openTerminalSearch(active.id);
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
  }
}
