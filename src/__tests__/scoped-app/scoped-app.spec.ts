// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createScopedApp } from '../../plugins/scoped-app';
import {
  InMemoryPermissionStore,
  PermissionError,
} from '../../plugins/permissions';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { EventBus } from '../../plugins/EventBus';
import { EditorActionRegistry } from '../../plugins/registries/EditorActionRegistry';
import { ExplorerDecoratorRegistry } from '../../plugins/registries/ExplorerDecoratorRegistry';
import { InMemoryDataStore } from '../../plugins/PluginDataStore';
import { PanelRegistry } from '../../plugins/registries/PanelRegistry';
import { RibbonRegistry } from '../../plugins/registries/RibbonRegistry';
import { SettingTabRegistry } from '../../plugins/registries/SettingTabRegistry';
import { StatusBarRegistry } from '../../plugins/registries/StatusBarRegistry';
import type { LMApp } from '../../plugins/types';

function makeLmApp(): LMApp {
  return {
    version: '1.0.0',
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
}

describe('createScopedApp 基础结构', () => {
  it('包含 fs / network / shell / clipboard / permission 5 个新字段', () => {
    const scoped = createScopedApp(makeLmApp(), 'p1', null);
    expect(typeof scoped.fs.readFile).toBe('function');
    expect(typeof scoped.network.fetch).toBe('function');
    expect(scoped.shell).toBeDefined();
    expect(typeof scoped.clipboard.readText).toBe('function');
    expect(typeof scoped.permission.check).toBe('function');
  });

  it('贡献点 registry 透传引用(两个 plugin 看到同一个 commands)', () => {
    const lmApp = makeLmApp();
    const a = createScopedApp(lmApp, 'p.a', null);
    const b = createScopedApp(lmApp, 'p.b', null);
    expect(a.commands).toBe(lmApp.commands);
    expect(b.commands).toBe(lmApp.commands);
    expect(a.commands).toBe(b.commands);
  });

  it('fs / clipboard / permission 是 per-plugin 闭包(不同引用)', () => {
    const lmApp = makeLmApp();
    const a = createScopedApp(lmApp, 'p.a', null);
    const b = createScopedApp(lmApp, 'p.b', null);
    expect(a.fs).not.toBe(b.fs);
    expect(a.permission).not.toBe(b.permission);
  });
});

describe('permission.check / granted', () => {
  it('store 为 null → check 一律 true,granted 返 []', async () => {
    const scoped = createScopedApp(makeLmApp(), 'p', null);
    expect(await scoped.permission.check('fs')).toBe(true);
    expect(await scoped.permission.check('network')).toBe(true);
    expect(await scoped.permission.granted()).toEqual([]);
  });

  it('store 非 null → 反映该 pluginId 的 granted=true 决策', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p.a', ['fs']);
    await store.deny('p.a', ['network']);
    const scoped = createScopedApp(makeLmApp(), 'p.a', store);
    expect(await scoped.permission.check('fs')).toBe(true);
    expect(await scoped.permission.check('network')).toBe(false);
    expect(await scoped.permission.check('clipboard')).toBe(false);
    const g = await scoped.permission.granted();
    expect(g).toEqual(['fs']);
  });

  it('per-plugin 隔离:p.a 的授权不被 p.b 看到', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p.a', ['fs']);
    const lmApp = makeLmApp();
    const a = createScopedApp(lmApp, 'p.a', store);
    const b = createScopedApp(lmApp, 'p.b', store);
    expect(await a.permission.check('fs')).toBe(true);
    expect(await b.permission.check('fs')).toBe(false);
  });
});

describe('fs / clipboard 默认实现(Phase 1 转发,无 gating)', () => {
  it('window.api.fs 未注入(jsdom)→ 抛"未注入"', async () => {
    const scoped = createScopedApp(makeLmApp(), 'p', null);
    await expect(scoped.fs.readFile('/x')).rejects.toThrow(/未注入/);
    await expect(scoped.fs.writeFile('/x', '')).rejects.toThrow(/未注入/);
    await expect(scoped.fs.listDir('/x')).rejects.toThrow(/未注入/);
  });
});

describe('PermissionError', () => {
  it('code = PERMISSION_DENIED,permission 字段暴露', () => {
    const err = new PermissionError('fs');
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.permission).toBe('fs');
    expect(err.message).toBe('权限 fs 未授权');
    expect(err.name).toBe('PermissionError');
    expect(err).toBeInstanceOf(Error);
  });

  it('自定义 message 覆盖默认', () => {
    const err = new PermissionError('network', 'fetch needs network');
    expect(err.message).toBe('fetch needs network');
    expect(err.permission).toBe('network');
  });
});
