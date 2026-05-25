// xterm 全套走 lazy chunk,Terminal panel 没打开时不下载。

import { lazy } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { useWorkspaceStore } from '@/stores/workspace.store';
import type { TerminalPanelViewParams } from '@/panels/Terminal/TerminalPanelView';
import { ERROR_CODES } from '../../electron/shared/error-codes';
import { t } from '@/i18n';
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
      fn: async () => {
        const workspaceRoot = useWorkspaceStore.getState().root ?? undefined;
        const r = await coApi.terminal.create({
          cwd: workspaceRoot,
          originHint: 'user',
          ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        });
        if (!r.ok) {
          const msg =
            r.code === ERROR_CODES.TERMINAL_CWD_UNRESOLVED
              ? t('errors.terminal.cwd_unresolved')
              : t('errors.terminal.create_failed', { code: r.code ?? '?' });
          notify.error(msg, { code: r.code });
          return;
        }
        if (!r.data?.id) return;
        const { setPendingFocus } = await import('@/shell/dock/DockReconciler');
        setPendingFocus(r.data.id);
      },
    });
  }
}
