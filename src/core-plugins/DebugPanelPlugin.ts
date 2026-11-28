import { lazy } from 'react';
import { Plugin } from '@/plugins/Plugin';
import { lazyPanel } from '@/lib/lazy-panel';
import { debugCommandSpecs } from '@/panels/Debug/debug-commands';
import { startDebugAutoReveal } from '@/panels/Debug/debug-auto-reveal';

const DebugPanel = lazy(() =>
  import('@/panels/Debug/DebugPanel').then((m) => ({ default: m.DebugPanel })),
);

export default class DebugPanelPlugin extends Plugin {
  onload(): void {
    this.registerPanel({
      type: 'debug',
      title: 'Debug',
      titleKey: 'panels.debug.title',
      multiInstance: true,
      factory: lazyPanel(DebugPanel),
    });
    // 调试工具栏命令(继续 F5 / 暂停 F6 / 单步 F10·F11·⇧F11 / 停止 ⇧F5),见 debug-commands。
    for (const spec of debugCommandSpecs()) this.addCommand(spec);
    // 调试停下时自动打开调试视图并定位停止位置(不抢焦点),见 debug-auto-reveal。
    this.register({ dispose: startDebugAutoReveal() });
  }
}
