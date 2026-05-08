// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function beforeEachClear(): void {
  beforeEach(() => {
    delete (window as { api?: unknown }).api;
  });
}
function afterEachClear(): void {
  afterEach(() => {
    delete (window as { api?: unknown }).api;
    vi.restoreAllMocks();
  });
}
import { createScopedApp } from '../../plugins/scoped-app';
import {
  InMemoryPermissionStore,
  PermissionError,
} from '../../plugins/permissions';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { EventBus } from '../../plugins/EventBus';
import { EditorActionRegistry } from '../../plugins/registries/EditorActionRegistry';
import { ExplorerContextMenuRegistry } from '../../plugins/registries/ExplorerContextMenuRegistry';
import { ExplorerDecoratorRegistry } from '../../plugins/registries/ExplorerDecoratorRegistry';
import { InMemoryDataStore } from '../../plugins/PluginDataStore';
import { PanelRegistry } from '../../plugins/registries/PanelRegistry';
import { RibbonRegistry } from '../../plugins/registries/RibbonRegistry';
import { SettingItemRegistry } from '../../plugins/registries/SettingItemRegistry';
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
    settingItems: new SettingItemRegistry(),
    explorerDecorators: new ExplorerDecoratorRegistry(),
    editorActions: new EditorActionRegistry(),
    explorerContextMenu: new ExplorerContextMenuRegistry(),
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

describe('授后转发 — fs / shell / clipboard / mcp / network 行为', () => {
  function installFs(fs: Record<string, unknown>): void {
    Object.defineProperty(window, 'api', {
      value: { fs, shell: {} },
      writable: true,
      configurable: true,
    });
  }
  function installFull(api: Record<string, unknown>): void {
    Object.defineProperty(window, 'api', {
      value: api,
      writable: true,
      configurable: true,
    });
  }

  beforeEachClear();
  afterEachClear();

  it('fs.readFile ok=true → 返 data', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    installFs({
      readFile: () => ({ ok: true, data: 'hello' }),
      writeFile: () => ({ ok: true, data: undefined }),
      listDir: () => ({ ok: true, data: [] }),
    });
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    expect(await scoped.fs.readFile('/x')).toBe('hello');
  });

  it('fs.readFile ok=false → 抛带 code:message 文案', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    installFs({
      readFile: () => ({ ok: false, code: 'ENOENT', message: 'gone' }),
      writeFile: () => ({ ok: false, code: 'EROFS', message: 'ro' }),
      listDir: () => ({ ok: false, code: 'EACCES', message: 'denied' }),
    });
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(scoped.fs.readFile('/x')).rejects.toThrow(/ENOENT.*gone/);
    await expect(scoped.fs.writeFile('/x', '')).rejects.toThrow(/EROFS.*ro/);
    await expect(scoped.fs.listDir('/x')).rejects.toThrow(/EACCES.*denied/);
  });

  it('fs.writeFile/listDir ok=true 透传 data', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    installFs({
      writeFile: () => ({ ok: true, data: undefined }),
      listDir: () => ({
        ok: true,
        data: [{ path: '/x/a', name: 'a', isDirectory: false }],
      }),
    });
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await scoped.fs.writeFile('/x', 'data');
    const list = await scoped.fs.listDir('/x');
    expect(list[0]?.name).toBe('a');
  });

  it('shell.exec 授后透传 + ok=true 返 data', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    installFull({
      shell: {
        exec: () => ({
          ok: true,
          data: { stdout: 'hi', stderr: '', exitCode: 0 },
        }),
      },
    });
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const r = await scoped.shell.exec('echo', ['hi']);
    expect(r.stdout).toBe('hi');
  });

  it('shell.exec ok=false → 抛带 code:message', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    installFull({
      shell: {
        exec: () => ({ ok: false, code: 'EBUSY', message: 'pty busy' }),
      },
    });
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(scoped.shell.exec('echo', [])).rejects.toThrow(
      /EBUSY.*pty busy/,
    );
  });

  it('mcp.register 授后调 registry.register(spec, pluginId)', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['mcp-tools']);
    const coApp = makeLmApp();
    const regSpy = vi.spyOn(coApp.mcp, 'register');
    const scoped = createScopedApp(coApp, 'p', store);
    const spec = {
      name: 'tool.x',
      description: 'desc',
      inputSchema: {} as never,
      run: async () => ({}),
    };
    await scoped.mcp.register(spec as never);
    expect(regSpy).toHaveBeenCalledWith(spec, 'p');
  });

  it('未授 mcp-tools → register 抛 PermissionError', async () => {
    const store = new InMemoryPermissionStore();
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(
      scoped.mcp.register({ name: 'x', run: async () => ({}) } as never),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it('permission.granted 列出已授项,deny 不计入', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    await store.deny('p', ['network']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const granted = await scoped.permission.granted();
    expect(granted).toEqual(['fs']);
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
