// 测试用 LMApp 工厂(M-Plugin v2.2,避免每加字段都改一堆 spec 夹具)。
// 不在生产代码路径上,但放 src/plugins/ 便于测试 import。

import { CommandRegistry } from './registries/CommandRegistry';
import { EventBus } from './EventBus';
import { InMemoryDataStore } from './PluginDataStore';
import { PanelRegistry } from './registries/PanelRegistry';
import { RibbonRegistry } from './registries/RibbonRegistry';
import { StatusBarRegistry } from './registries/StatusBarRegistry';
import type { LMApp } from './types';

export function createTestApp(version = '1.0.0-test'): LMApp {
  return {
    version,
    panels: new PanelRegistry(),
    commands: new CommandRegistry(),
    statusBar: new StatusBarRegistry(),
    ribbon: new RibbonRegistry(),
    events: new EventBus(),
    dataStore: new InMemoryDataStore(),
  };
}
