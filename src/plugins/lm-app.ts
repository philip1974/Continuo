// 全局 LMApp 实例(M-Plugin v1)。
// 单例:registry 在此创建,贡献点跨整个 app 共享;Plugin 通过 app 字段访问。
//
// 后续(v2+)若加 events / fs / log 等,在此扩 LMApp 接口与实例。

import { CommandRegistry } from './registries/CommandRegistry';
import { EventBus } from './EventBus';
import { InMemoryDataStore } from './PluginDataStore';
import { PanelRegistry } from './registries/PanelRegistry';
import { RibbonRegistry } from './registries/RibbonRegistry';
import { SettingTabRegistry } from './registries/SettingTabRegistry';
import { StatusBarRegistry } from './registries/StatusBarRegistry';
import type { LMApp } from './types';

const APP_VERSION = '0.1.0';

export const lmApp: LMApp = {
  version: APP_VERSION,
  panels: new PanelRegistry(),
  commands: new CommandRegistry(),
  statusBar: new StatusBarRegistry(),
  ribbon: new RibbonRegistry(),
  events: new EventBus(),
  // v2.3 默认 InMemoryDataStore;v3 接入 IPC 持久化
  dataStore: new InMemoryDataStore(),
  settingTabs: new SettingTabRegistry(),
};
