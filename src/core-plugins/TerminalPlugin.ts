// xterm 全套走 lazy chunk,Terminal panel 没打开时不下载。

import { lazy } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';

type TerminalPanelParams = {
  sessionId?: string;
  cwd?: string;
  title?: string;
  role?: string;
};

const Terminal = lazy(() =>
  import('@/panels/Terminal').then((m) => ({ default: m.Terminal })),
);

export default class TerminalPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: 'terminal',
      title: 'Terminal',
      factory: lazyPanel<IDockviewPanelProps<TerminalPanelParams>>(Terminal),
    });
  }
}
