// 测试用 CoApp 工厂(M-Plugin v2.2,避免每加字段都改一堆 spec 夹具)。
// 不在生产代码路径上,但放 src/plugins/ 便于测试 import。
//
// v5 Phase 1:返回 CoPluginApp(scoped to id='test',无 PermissionStore),
// 让现有测试不用每个都 wrap createScopedApp。

import { CommandRegistry } from './registries/CommandRegistry';
import { EventBus } from './EventBus';
import { EditorActionRegistry } from './registries/EditorActionRegistry';
import { ExplorerContextMenuRegistry } from './registries/ExplorerContextMenuRegistry';
import { ExplorerDecoratorRegistry } from './registries/ExplorerDecoratorRegistry';
import { InMemoryDataStore } from './PluginDataStore';
import { PanelRegistry } from './registries/PanelRegistry';
import {
  PluginMcpRegistry,
  type PluginMcpUpstream,
} from './registries/PluginMcpRegistry';
import { RibbonRegistry } from './registries/RibbonRegistry';
import { SettingItemRegistry } from './registries/SettingItemRegistry';
import { SettingTabRegistry } from './registries/SettingTabRegistry';
import { StatusBarRegistry } from './registries/StatusBarRegistry';
import { createScopedApp } from './scoped-app';
import type { CoApp, CoPluginApp } from './types';

const noopMcpUpstream: PluginMcpUpstream = {
  async register() {
    /* noop */
  },
  async unregister() {
    /* noop */
  },
};

/** 测试 CoApp 工厂(给 PluginManager / handleProtocolUrl 等接 CoApp 的代码用). */
export function createTestCoApp(version = '1.0.0-test'): CoApp {
  return {
    version,
    panels: new PanelRegistry(),
    commands: new CommandRegistry(),
    statusBar: new StatusBarRegistry(),
    ribbon: new RibbonRegistry(),
    events: new EventBus(),
    dataStore: new InMemoryDataStore(),
    settingTabs: new SettingTabRegistry(),
    settingItems: new SettingItemRegistry(),
    explorerDecorators: new ExplorerDecoratorRegistry(),
    editorActions: new EditorActionRegistry(),
    explorerContextMenu: new ExplorerContextMenuRegistry(),
    mcp: new PluginMcpRegistry(noopMcpUpstream),
  };
}

/** 测试 CoPluginApp 工厂(给 Plugin constructor 等接 CoPluginApp 的代码用). */
export function createTestApp(
  version = '1.0.0-test',
  pluginId = 'test',
): CoPluginApp {
  return createScopedApp(createTestCoApp(version), pluginId, null);
}
