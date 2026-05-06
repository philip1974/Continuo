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
import type { CoApp } from '../../plugins/types';
import {
  PluginMcpRegistry,
  type PluginMcpUpstream,
} from '../../plugins/registries/PluginMcpRegistry';

const noopMcpUpstream: PluginMcpUpstream = {
  async register() {},
  async unregister() {},
};

function makeLmApp(): CoApp {
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
    mcp: new PluginMcpRegistry(noopMcpUpstream),
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
    const coApp = makeLmApp();
    const a = createScopedApp(coApp, 'p.a', null);
    const b = createScopedApp(coApp, 'p.b', null);
    expect(a.commands).toBe(coApp.commands);
    expect(b.commands).toBe(coApp.commands);
    expect(a.commands).toBe(b.commands);
  });

  it('fs / clipboard / permission 是 per-plugin 闭包(不同引用)', () => {
    const coApp = makeLmApp();
    const a = createScopedApp(coApp, 'p.a', null);
    const b = createScopedApp(coApp, 'p.b', null);
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
    const coApp = makeLmApp();
    const a = createScopedApp(coApp, 'p.a', store);
    const b = createScopedApp(coApp, 'p.b', store);
    expect(await a.permission.check('fs')).toBe(true);
    expect(await b.permission.check('fs')).toBe(false);
  });
});

describe('fs / clipboard 默认实现(store=null 跳过 gating)', () => {
  it('store=null + window.api.fs 未注入(jsdom)→ 抛"未注入"', async () => {
    const scoped = createScopedApp(makeLmApp(), 'p', null);
    await expect(scoped.fs.readFile('/x')).rejects.toThrow(/未注入/);
    await expect(scoped.fs.writeFile('/x', '')).rejects.toThrow(/未注入/);
    await expect(scoped.fs.listDir('/x')).rejects.toThrow(/未注入/);
  });
});

describe('Phase 3 runtime gating', () => {
  it('store 非 null 且未授 fs → fs.readFile 抛 PermissionError(不到达 window.api)', async () => {
    const store = new InMemoryPermissionStore();
    // 不 grant 任何
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(scoped.fs.readFile('/x')).rejects.toBeInstanceOf(
      PermissionError,
    );
    await expect(scoped.fs.writeFile('/x', '')).rejects.toBeInstanceOf(
      PermissionError,
    );
    await expect(scoped.fs.listDir('/x')).rejects.toBeInstanceOf(
      PermissionError,
    );
  });

  it('已 deny fs → fs.* 抛 PermissionError', async () => {
    const store = new InMemoryPermissionStore();
    await store.deny('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const err = await scoped.fs.readFile('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);
    if (err instanceof PermissionError) {
      expect(err.permission).toBe('fs');
      expect(err.code).toBe('PERMISSION_DENIED');
    }
  });

  it('已 grant fs → fs.* 透传,window.api 未注入时抛"未注入"(过 gating)', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(scoped.fs.readFile('/x')).rejects.toThrow(/未注入/);
  });

  it('未授 network → fetch 抛 PermissionError(不调 globalThis.fetch)', async () => {
    const store = new InMemoryPermissionStore();
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const err = await scoped.network
      .fetch('https://example.com')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);
    if (err instanceof PermissionError) {
      expect(err.permission).toBe('network');
    }
  });

  it('未授 clipboard → readText/writeText 抛 PermissionError', async () => {
    const store = new InMemoryPermissionStore();
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(scoped.clipboard.readText()).rejects.toBeInstanceOf(
      PermissionError,
    );
    await expect(scoped.clipboard.writeText('x')).rejects.toBeInstanceOf(
      PermissionError,
    );
  });

  it('未授 shell → exec 抛 PermissionError(不到 IPC)', async () => {
    const store = new InMemoryPermissionStore();
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const err = await scoped.shell
      .exec('echo', ['hi'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);
    if (err instanceof PermissionError) {
      expect(err.permission).toBe('shell');
    }
  });

  it('per-plugin 隔离:p.a 授了 fs,p.b 没授 → p.b 仍抛 PermissionError', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p.a', ['fs']);
    const coApp = makeLmApp();
    const a = createScopedApp(coApp, 'p.a', store);
    const b = createScopedApp(coApp, 'p.b', store);
    await expect(a.fs.readFile('/x')).rejects.toThrow(/未注入/); // 过 gating
    await expect(b.fs.readFile('/x')).rejects.toBeInstanceOf(PermissionError);
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
