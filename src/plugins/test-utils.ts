// 测试用 CoApp 工厂(M-Plugin v2.2,避免每加字段都改一堆 spec 夹具)。
// 不在生产代码路径上,但放 src/plugins/ 便于测试 import。
//
// v5 Phase 1:返回 CoPluginApp(scoped to id='test',无 PermissionStore),
// 让现有测试不用每个都 wrap createScopedApp。

import { CommandRegistry } from './registries/CommandRegistry';
import { EventBus } from './EventBus';
import { EditorActionRegistry } from './registries/EditorActionRegistry';
import { ExplorerDecoratorRegistry } from './registries/ExplorerDecoratorRegistry';
import { InMemoryDataStore } from './PluginDataStore';
import { PanelRegistry } from './registries/PanelRegistry';
import { RibbonRegistry } from './registries/RibbonRegistry';
import { SettingTabRegistry } from './registries/SettingTabRegistry';
import { StatusBarRegistry } from './registries/StatusBarRegistry';
import { createScopedApp } from './scoped-app';
import type { CoApp, CoPluginApp } from './types';

export function createTestApp(
  version = '1.0.0-test',
  pluginId = 'test',
): CoPluginApp {
  const base: CoApp = {
    version,
    panels: new PanelRegistry(),
    commands: new CommandRegistry(),
    statusBar: new StatusBarRegistry(),
    ribbon: new RibbonRegistry(),
    events: new EventBus(),
    dataStore: new InMemoryDataStore(),
    settingTabs: new SettingTabRegistry(),
    explorerDecorators: new ExplorerDecoratorRegistry(),
    editorActions: new EditorActionRegistry(),
  };
  return createScopedApp(base, pluginId, null);
}
