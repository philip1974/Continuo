// 全局 CoApp 实例(M-Plugin v1)。
// 单例:registry 在此创建,贡献点跨整个 app 共享;Plugin 通过 app 字段访问。
//
// 后续(v2+)若加 events / fs / log 等,在此扩 CoApp 接口与实例。

import { CommandRegistry } from './registries/CommandRegistry';
import { EventBus } from './EventBus';
import { EditorActionRegistry } from './registries/EditorActionRegistry';
import { ExplorerContextMenuRegistry } from './registries/ExplorerContextMenuRegistry';
import { ExplorerDecoratorRegistry } from './registries/ExplorerDecoratorRegistry';
import { IpcPluginDataStore } from './PluginDataStore';
import { PanelRegistry } from './registries/PanelRegistry';
import { PluginMcpRegistry } from './registries/PluginMcpRegistry';
import { RibbonRegistry } from './registries/RibbonRegistry';
import { SettingItemRegistry } from './registries/SettingItemRegistry';
import { SettingTabRegistry } from './registries/SettingTabRegistry';
import { StatusBarRegistry } from './registries/StatusBarRegistry';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { createIpcPluginMcpUpstream } from './plugin-mcp-upstream';
import type { CoApp, CoWorkspaceApi } from './types';

// Keep in sync with package.json "version" field. Bumped to 0.2.2 (2026-05-31)
// for the workspace.getRoot() SDK addition (Plan 05 extension #3 — lets
// plugins resolve the current workspace root for project-scope file ops
// without manual config). Plugins declaring minLMVersion >= 0.2.2 need this.
const APP_VERSION = '0.2.2';

// Workspace API — minimal v0.1 surface exposing the current renderer
// window's workspace root (null when no folder open). Plugins use this for
// project-scope features (e.g. resolving project skills root, project
// terminal cwd). Per-window because each Continuo window has its own root.
const workspace: CoWorkspaceApi = {
  async getRoot() {
    return useWorkspaceStore.getState().root;
  },
};

// v5 Phase 4:Plugin → MCP bridge — registry 持 IPC upstream,
// dispose 时通过 preload.pluginMcp.unregisterTool 上行,renderer 启动时
// 在 main.tsx 订阅 onInvoke 把反向调用路由到 registry.invokeLocal。
const pluginMcpRegistry = new PluginMcpRegistry(
  createIpcPluginMcpUpstream(),
);

export const coApp: CoApp = {
  version: APP_VERSION,
  panels: new PanelRegistry(),
  commands: new CommandRegistry(),
  statusBar: new StatusBarRegistry(),
  ribbon: new RibbonRegistry(),
  events: new EventBus(),
  // Lazy IPC-backed; first plugin data read triggers load from userData.
  dataStore: new IpcPluginDataStore(),
  settingTabs: new SettingTabRegistry(),
  settingItems: new SettingItemRegistry(),
  explorerDecorators: new ExplorerDecoratorRegistry(),
  editorActions: new EditorActionRegistry(),
  explorerContextMenu: new ExplorerContextMenuRegistry(),
  mcp: pluginMcpRegistry,
  workspace,
};

/** 让 main.tsx 拿到 registry 引用,在启动时订阅 onInvoke 路由反向调用. */
export function getPluginMcpRegistry(): PluginMcpRegistry {
  return pluginMcpRegistry;
}
