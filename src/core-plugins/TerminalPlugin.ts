// xterm 全套走 lazy chunk,Terminal panel 没打开时不下载。

import { lazy } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';
import { coApi } from '@/lib/co-api';
import { useWorkspaceStore } from '@/stores/workspace.store';
import type { TerminalPanelViewParams } from '@/panels/Terminal/TerminalPanelView';

const TerminalPanelView = lazy(() =>
  import('@/panels/Terminal/TerminalPanelView').then((m) => ({
    default: m.TerminalPanelView,
  })),
);

export default class TerminalPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: 'terminal',
      title: 'Terminal',
      factory: lazyPanel<IDockviewPanelProps<TerminalPanelViewParams>>(
        TerminalPanelView,
      ),
    });
    this.addCommand({
      id: 'terminal.new',
      title: '新建终端',
      category: 'Terminal',
      hotkey: 'mod+t',
      fn: async () => {
        const workspaceRoot = useWorkspaceStore.getState().root ?? undefined;
        const r = await coApi.terminal.create({
          cwd: workspaceRoot,
          originHint: 'user',
          ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        });
        if (!r.ok || !r.data?.id) return;
        const { setPendingFocus } = await import('@/shell/dock/DockReconciler');
        setPendingFocus(r.data.id);
      },
    });
  }
}
