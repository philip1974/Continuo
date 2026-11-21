import { lazy } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';

const DebugPanel = lazy(() =>
  import('@/panels/Debug/DebugPanel').then((m) => ({ default: m.DebugPanel })),
);

export default class DebugPanelPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: 'debug',
      title: 'Debug',
      titleKey: 'panels.debug.title',
      factory: lazyPanel(DebugPanel),
    });
  }
}
