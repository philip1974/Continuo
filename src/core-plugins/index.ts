// Core plugins boot(M-Plugin v1.7)。
// 同步实例化 + _activate,假设 core plugin onload 都是同步的(不 await IPC)。
// 微任务后 _activate Promise 完成,但 register* 在 onload 内同步执行,
// 所以同步 boot 后 coApp.<reg>.getAll() 已包含贡献。

import EditorPlugin from './EditorPlugin';
import EditorTabPlugin from './EditorTabPlugin';
import ExplorerTabPlugin from './ExplorerTabPlugin';
import GeneralTabPlugin from './GeneralTabPlugin';
import TerminalTabPlugin from './TerminalTabPlugin';
import TerminalPlugin from './TerminalPlugin';
import OutputPlugin from './OutputPlugin';
import PluginsTabPlugin from './PluginsTabPlugin';
import SettingsPanelPlugin from './SettingsPanelPlugin';
import KeybindingsTabPlugin from './KeybindingsTabPlugin';
import { coApp } from '@/plugins/co-app';
import { createScopedApp } from '@/plugins/scoped-app';
import type { Plugin } from '@/plugins/Plugin';
import type { CoPluginApp, PluginManifest } from '@/plugins/types';

interface CoreEntry {
  readonly Cls: new (app: CoPluginApp, m: PluginManifest) => Plugin;
  readonly manifest: PluginManifest;
}

const CORES: readonly CoreEntry[] = [
  {
    Cls: EditorPlugin as never,
    manifest: { id: 'core.editor', name: 'Editor', version: '1.0.0' },
  },
  {
    Cls: TerminalPlugin as never,
    manifest: { id: 'core.terminal', name: 'Terminal', version: '1.0.0' },
  },
  {
    Cls: OutputPlugin as never,
    manifest: { id: 'core.output', name: 'Output', version: '1.0.0' },
  },
  {
    Cls: PluginsTabPlugin as never,
    manifest: { id: 'core.plugins', name: 'PluginsTab', version: '1.0.0' },
  },
  {
    Cls: SettingsPanelPlugin as never,
    manifest: {
      id: 'core.settings-panel',
      name: 'SettingsPanel',
      version: '1.0.0',
    },
  },
  {
    Cls: KeybindingsTabPlugin as never,
    manifest: { id: 'core.keybindings', name: 'KeybindingsTab', version: '1.0.0' },
  },
  {
    Cls: GeneralTabPlugin as never,
    manifest: { id: 'core.general', name: 'GeneralTab', version: '1.0.0' },
  },
  {
    Cls: EditorTabPlugin as never,
    manifest: { id: 'core.editor-tab', name: 'EditorTab', version: '1.0.0' },
  },
  {
    Cls: ExplorerTabPlugin as never,
    manifest: { id: 'core.explorer-tab', name: 'ExplorerTab', version: '1.0.0' },
  },
  {
    Cls: TerminalTabPlugin as never,
    manifest: { id: 'core.terminal-tab', name: 'TerminalTab', version: '1.0.0' },
  },
];

const instances: Plugin[] = [];

/** 启动期同步注册全部内置插件(register* 在 onload 内同步执行). */
export function bootCorePlugins(): void {
  for (const { Cls, manifest } of CORES) {
    // v5 Phase 1:core plugin 也走 ScopedApp,store=null → permission.check 一律 true
    const scopedApp = createScopedApp(coApp, manifest.id, null);
    const inst = new Cls(scopedApp, manifest);
    instances.push(inst);
    // _activate 是 async 但 onload 是同步,fire and forget;register 已同步发生
    void inst._activate();
  }
}

/** 测试 / HMR 用:卸载全部内置插件. */
export async function shutdownCorePlugins(): Promise<void> {
  for (let i = instances.length - 1; i >= 0; i--) {
    await instances[i]!._deactivate();
  }
  instances.length = 0;
}
