// @vitest-environment jsdom
// BDD: plugin-mcp-permission
// 测 PermissionKey 'mcp-tools' + scoped-app.mcp.register 权限门。
//
// 此 spec 在实装前会 red:
// - permissions.ts 还没 'mcp-tools'
// - scoped-app.ts 还没 mcp 字段
// - types.ts CoApp/CoPluginApp 还没 mcp 字段

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createScopedApp } from '../../plugins/scoped-app';
import {
  InMemoryPermissionStore,
  PermissionError,
  PERMISSION_KEYS,
  type PermissionKey,
} from '../../plugins/permissions';
import { parseManifest } from '../../plugins/manifest';
import { PanelRegistry } from '../../plugins/registries/PanelRegistry';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { StatusBarRegistry } from '../../plugins/registries/StatusBarRegistry';
import { RibbonRegistry } from '../../plugins/registries/RibbonRegistry';
import { EventBus } from '../../plugins/EventBus';
import { InMemoryDataStore } from '../../plugins/PluginDataStore';
import { SettingItemRegistry } from '../../plugins/registries/SettingItemRegistry';
import { SettingTabRegistry } from '../../plugins/registries/SettingTabRegistry';
import { ExplorerContextMenuRegistry } from '../../plugins/registries/ExplorerContextMenuRegistry';
import { ExplorerDecoratorRegistry } from '../../plugins/registries/ExplorerDecoratorRegistry';
import { EditorActionRegistry } from '../../plugins/registries/EditorActionRegistry';
import {
  PluginMcpRegistry,
  type PluginMcpToolSpec,
  type PluginMcpUpstream,
} from '../../plugins/registries/PluginMcpRegistry';
import type { CoApp } from '../../plugins/types';

// ─── helpers ─────────────────────────────────────────────────

function makeFakeUpstream(): PluginMcpUpstream {
  return {
    async register() {
      /* noop ok */
    },
    async unregister() {
      /* noop */
    },
  };
}

function makeApp(registry?: PluginMcpRegistry): CoApp {
  return {
    version: '1.0.0-test',
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
    mcp: registry ?? new PluginMcpRegistry(makeFakeUpstream()),
  };
}

function makeSpec(name: string): PluginMcpToolSpec {
  return {
    name,
    description: `${name} desc`,
    jsonSchema: { type: 'object', additionalProperties: false },
    inputSchema: z.object({}).strict(),
    run: () => ({}),
  };
}

// ────────────────────────────────────────────────────────────
// PermissionKey 列表
// ────────────────────────────────────────────────────────────

describe('PERMISSION_KEYS 含 mcp-tools', () => {
  it('PERMISSION_KEYS 数组包含 mcp-tools', () => {
    expect(PERMISSION_KEYS).toContain('mcp-tools' as PermissionKey);
  });
});

// ────────────────────────────────────────────────────────────
// Manifest schema 接受 mcp-tools
// ────────────────────────────────────────────────────────────

describe('Manifest permissions schema', () => {
  it('permissions: ["mcp-tools"] → ok', () => {
    const r = parseManifest(
      JSON.stringify({
        id: 'a.b',
        name: 'X',
        version: '1.0.0',
        permissions: ['mcp-tools'],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.permissions).toEqual(['mcp-tools']);
  });

  it('permissions: ["fs", "mcp-tools"] 混合 → ok', () => {
    const r = parseManifest(
      JSON.stringify({
        id: 'a.b',
        name: 'X',
        version: '1.0.0',
        permissions: ['fs', 'mcp-tools'],
      }),
    );
    expect(r.ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// scoped-app.mcp.register · 未声明 / 已 deny / store=null / granted
// ────────────────────────────────────────────────────────────

describe('scoped-app.mcp.register · gating', () => {
  it('store 非 null 且未授 mcp-tools → 抛 PermissionError', async () => {
    const store = new InMemoryPermissionStore();
    const scoped = createScopedApp(makeApp(), 'p', store);
    const err = await scoped.mcp.register(makeSpec('a')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);
    if (err instanceof PermissionError) {
      expect(err.permission).toBe('mcp-tools');
      expect(err.code).toBe('PERMISSION_DENIED');
    }
  });

  it('已 deny mcp-tools → 抛 PermissionError', async () => {
    const store = new InMemoryPermissionStore();
    await store.deny('p', ['mcp-tools']);
    const scoped = createScopedApp(makeApp(), 'p', store);
    const err = await scoped.mcp.register(makeSpec('a')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);
    if (err instanceof PermissionError) {
      expect(err.permission).toBe('mcp-tools');
    }
  });

  it('已 grant mcp-tools → 透传调底层 registry,返回 Disposable', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['mcp-tools']);
    const upstream: PluginMcpUpstream = {
      register: vi.fn(async () => {}),
      unregister: vi.fn(async () => {}),
    };
    const registry = new PluginMcpRegistry(upstream);
    const scoped = createScopedApp(makeApp(registry), 'p', store);
    const d = await scoped.mcp.register(makeSpec('a'));
    expect(typeof d.dispose).toBe('function');
    expect(upstream.register).toHaveBeenCalledOnce();
  });

  it('store=null → 跳过 gating,直接透传(向后兼容)', async () => {
    const upstream: PluginMcpUpstream = {
      register: vi.fn(async () => {}),
      unregister: vi.fn(async () => {}),
    };
    const registry = new PluginMcpRegistry(upstream);
    const scoped = createScopedApp(makeApp(registry), 'p', null);
    const d = await scoped.mcp.register(makeSpec('a'));
    expect(typeof d.dispose).toBe('function');
    expect(upstream.register).toHaveBeenCalledOnce();
  });

  it('权限通过后底层 registry 抛 TOOL_NAME_TAKEN → 透传(不是 PermissionError)', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['mcp-tools']);
    const upstream: PluginMcpUpstream = {
      register: vi.fn(async () => {
        throw Object.assign(new Error('name x already taken'), {
          code: 'TOOL_NAME_TAKEN',
        });
      }),
      unregister: vi.fn(async () => {}),
    };
    const registry = new PluginMcpRegistry(upstream);
    const scoped = createScopedApp(makeApp(registry), 'p', store);
    const err = await scoped.mcp.register(makeSpec('x')).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PermissionError);
    expect((err as { code?: string }).code).toBe('TOOL_NAME_TAKEN');
  });
});

// ────────────────────────────────────────────────────────────
// per-plugin 隔离
// ────────────────────────────────────────────────────────────

describe('per-plugin 隔离', () => {
  it('p.a 授了 mcp-tools,p.b 未授 → p.b 抛 PermissionError,p.a 通过', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p.a', ['mcp-tools']);
    const upstream: PluginMcpUpstream = {
      register: vi.fn(async () => {}),
      unregister: vi.fn(async () => {}),
    };
    const registry = new PluginMcpRegistry(upstream);
    const app = makeApp(registry);
    const a = createScopedApp(app, 'p.a', store);
    const b = createScopedApp(app, 'p.b', store);
    await expect(a.mcp.register(makeSpec('a-tool'))).resolves.toBeDefined();
    await expect(b.mcp.register(makeSpec('b-tool'))).rejects.toBeInstanceOf(
      PermissionError,
    );
  });
});

// ────────────────────────────────────────────────────────────
// CoPluginApp.mcp 是 per-plugin 闭包(底下共享 registry)
// ────────────────────────────────────────────────────────────

describe('CoPluginApp.mcp · per-plugin 闭包', () => {
  it('两个 plugin 的 scoped.mcp 是不同对象', () => {
    const app = makeApp();
    const a = createScopedApp(app, 'p.a', null);
    const b = createScopedApp(app, 'p.b', null);
    expect(a.mcp).not.toBe(b.mcp);
  });

  it('CoApp.mcp 是单例(同 app 看到同一 registry)', () => {
    const app = makeApp();
    const a = createScopedApp(app, 'p.a', null);
    const b = createScopedApp(app, 'p.b', null);
    // CoApp.mcp 是单例,scoped 应转发到同一 registry —
    // 通过"两边都注册同名 → 第二次抛 TOOL_NAME_TAKEN"间接断言
    return (async () => {
      await a.mcp.register(makeSpec('shared'));
      const err = await b.mcp.register(makeSpec('shared')).catch((e: unknown) => e);
      // 因 store=null 跳 gating,失败必来自底层 registry
      expect((err as { code?: string }).code).toBe('TOOL_NAME_TAKEN');
    })();
  });
});
