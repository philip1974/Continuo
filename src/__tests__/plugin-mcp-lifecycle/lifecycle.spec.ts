// BDD: plugin-mcp-lifecycle
// 测 Plugin.registerMcpTool proxy + Disposable LIFO 清理。
//
// 此 spec 在实装前会 red(Plugin.registerMcpTool 不存在 / CoPluginApp.mcp 不存在)。
// 实装目标:
//   src/plugins/Plugin.ts 加 protected registerMcpTool(spec): Promise<Disposable>
//   src/plugins/types.ts CoApp / CoPluginApp 加 mcp 字段

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Plugin, type Disposable } from '../../plugins/Plugin';
import type {
  CoApp,
  CoPluginApp,
  PluginManifest,
} from '../../plugins/types';
import type { PluginMcpToolSpec } from '../../plugins/registries/PluginMcpRegistry';
import { PanelRegistry } from '../../plugins/registries/PanelRegistry';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { StatusBarRegistry } from '../../plugins/registries/StatusBarRegistry';
import { RibbonRegistry } from '../../plugins/registries/RibbonRegistry';
import { EventBus } from '../../plugins/EventBus';
import { InMemoryDataStore } from '../../plugins/PluginDataStore';
import { SettingTabRegistry } from '../../plugins/registries/SettingTabRegistry';
import { ExplorerDecoratorRegistry } from '../../plugins/registries/ExplorerDecoratorRegistry';
import { EditorActionRegistry } from '../../plugins/registries/EditorActionRegistry';

// ─── fake mcp api(实装边界:CoPluginApp.mcp.register)──────────

interface FakeMcpApi {
  register: ReturnType<typeof vi.fn>;
  /** 累计成功注册过的 name,供 unregister 触发顺序断言. */
  readonly unregisterLog: string[];
}

function makeFakeMcpApi(opts: {
  failOnName?: string;
  failError?: Error;
} = {}): FakeMcpApi {
  const unregisterLog: string[] = [];
  const register = vi.fn(
    async (spec: PluginMcpToolSpec): Promise<Disposable> => {
      if (opts.failOnName && spec.name === opts.failOnName) {
        throw opts.failError ?? new Error(`fail on ${spec.name}`);
      }
      return {
        dispose() {
          unregisterLog.push(spec.name);
        },
      };
    },
  );
  return { register, unregisterLog };
}

function makeAppWithMcp(mcp: FakeMcpApi): CoPluginApp {
  // 直接构 CoPluginApp(本 topic 不验 CoApp.mcp 单例 → CoPluginApp.mcp 闭包的转换;
  // mcp 强转成 CoPluginApp['mcp'] = PluginMcpApi 形态,因 fake.register 签名匹配)。
  const baseRest: Omit<CoApp, 'mcp'> = {
    version: '1.0.0-test',
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
  return {
    ...baseRest,
    fs: {
      readFile: async () => '',
      writeFile: async () => {},
      listDir: async () => [],
    },
    network: { fetch: async () => new Response() },
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false }) },
    clipboard: { readText: async () => '', writeText: async () => {} },
    permission: { check: async () => true, granted: async () => [] },
    mcp: mcp as unknown as CoPluginApp['mcp'],
  };
}

// ─── tool spec fixture ───────────────────────────────────────

function makeSpec(name: string): PluginMcpToolSpec {
  return {
    name,
    description: `${name} desc`,
    jsonSchema: { type: 'object', additionalProperties: false },
    inputSchema: z.object({}).strict(),
    run: () => ({}),
  };
}

const baseManifest: PluginManifest = {
  id: 'test.plugin',
  name: 'Test',
  version: '0.1.0',
};

// ────────────────────────────────────────────────────────────
// registerMcpTool — 成功
// ────────────────────────────────────────────────────────────

describe('Plugin.registerMcpTool · 成功路径', () => {
  it('proxy 调 app.mcp.register(spec) 一次', async () => {
    const mcp = makeFakeMcpApi();
    const app = makeAppWithMcp(mcp);
    class P extends Plugin {
      override async onload() {
        await this.registerMcpTool(makeSpec('a'));
      }
    }
    const p = new P(app, baseManifest);
    await p._activate();
    expect(mcp.register).toHaveBeenCalledOnce();
    expect(mcp.register.mock.calls[0]![0].name).toBe('a');
  });

  it('返回的 Disposable 入 plugin 的 disposables(_deactivate 时 dispose)', async () => {
    const mcp = makeFakeMcpApi();
    const app = makeAppWithMcp(mcp);
    class P extends Plugin {
      override async onload() {
        await this.registerMcpTool(makeSpec('a'));
      }
    }
    const p = new P(app, baseManifest);
    await p._activate();
    expect(mcp.unregisterLog).toEqual([]); // 还没 deactivate
    await p._deactivate();
    expect(mcp.unregisterLog).toEqual(['a']);
  });
});

// ────────────────────────────────────────────────────────────
// registerMcpTool — 失败
// ────────────────────────────────────────────────────────────

describe('Plugin.registerMcpTool · 失败', () => {
  it('app.mcp.register reject → proxy reject 透传,disposables 不增', async () => {
    const mcp = makeFakeMcpApi({
      failOnName: 'bad',
      failError: Object.assign(new Error('repeat name'), { code: 'TOOL_NAME_TAKEN' }),
    });
    const app = makeAppWithMcp(mcp);
    let caught: unknown = null;
    class P extends Plugin {
      override async onload() {
        try {
          await this.registerMcpTool(makeSpec('bad'));
        } catch (e) {
          caught = e;
        }
      }
    }
    const p = new P(app, baseManifest);
    await p._activate();
    expect((caught as Error).message).toBe('repeat name');
    expect((caught as { code?: string }).code).toBe('TOOL_NAME_TAKEN');
    // 失败的不会触发 unregister(本来就没注册)
    await p._deactivate();
    expect(mcp.unregisterLog).toEqual([]);
  });

  it('plugin 可在 catch 后继续注册其他 tool', async () => {
    const mcp = makeFakeMcpApi({ failOnName: 'bad' });
    const app = makeAppWithMcp(mcp);
    class P extends Plugin {
      override async onload() {
        await this.registerMcpTool(makeSpec('ok-a'));
        try {
          await this.registerMcpTool(makeSpec('bad'));
        } catch {
          /* 容忍 */
        }
        await this.registerMcpTool(makeSpec('ok-b'));
      }
    }
    const p = new P(app, baseManifest);
    await p._activate();
    await p._deactivate();
    // LIFO:后注册的先 dispose
    expect(mcp.unregisterLog).toEqual(['ok-b', 'ok-a']);
  });
});

// ────────────────────────────────────────────────────────────
// LIFO 反序清理 + 多 tool
// ────────────────────────────────────────────────────────────

describe('LIFO 反序清理', () => {
  it('3 个 tool 注册顺序 a/b/c → _deactivate dispose 顺序 c/b/a', async () => {
    const mcp = makeFakeMcpApi();
    const app = makeAppWithMcp(mcp);
    class P extends Plugin {
      override async onload() {
        await this.registerMcpTool(makeSpec('a'));
        await this.registerMcpTool(makeSpec('b'));
        await this.registerMcpTool(makeSpec('c'));
      }
    }
    const p = new P(app, baseManifest);
    await p._activate();
    await p._deactivate();
    expect(mcp.unregisterLog).toEqual(['c', 'b', 'a']);
  });

  it('单个 dispose 抛错 → 其他仍执行,不传染', async () => {
    const log: string[] = [];
    // 自定义 mcp 让 b 的 dispose 抛错
    const mcp: FakeMcpApi = {
      register: vi.fn(async (spec: PluginMcpToolSpec): Promise<Disposable> => {
        return {
          dispose() {
            if (spec.name === 'b') throw new Error('dispose b boom');
            log.push(spec.name);
          },
        };
      }),
      unregisterLog: log,
    };
    const app = makeAppWithMcp(mcp);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    class P extends Plugin {
      override async onload() {
        await this.registerMcpTool(makeSpec('a'));
        await this.registerMcpTool(makeSpec('b'));
        await this.registerMcpTool(makeSpec('c'));
      }
    }
    const p = new P(app, baseManifest);
    await p._activate();
    await p._deactivate();
    // c 先 dispose(成功),b 抛错(被吞),a 后 dispose(成功)
    expect(log).toEqual(['c', 'a']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────
// 与 panel/command 等其他贡献点的 LIFO 顺序混合
// ────────────────────────────────────────────────────────────

describe('与其他贡献点混合清理', () => {
  it('混合注册 panel/mcp/command → LIFO 反序', async () => {
    const log: string[] = [];
    const mcp: FakeMcpApi = {
      register: vi.fn(async (spec: PluginMcpToolSpec): Promise<Disposable> => ({
        dispose: () => log.push(`mcp:${spec.name}`),
      })),
      unregisterLog: log,
    };
    const app = makeAppWithMcp(mcp);
    // 替换 panels.register 让 dispose 写日志
    const realPanelRegister = app.panels.register.bind(app.panels);
    vi.spyOn(app.panels, 'register').mockImplementation((spec) => {
      const d = realPanelRegister(spec);
      return {
        dispose() {
          log.push('panel');
          d.dispose();
        },
      };
    });
    class P extends Plugin {
      override async onload() {
        this.registerPanel({ type: 'pan1', title: 'P', factory: () => null });
        await this.registerMcpTool(makeSpec('mtool'));
        this.addCommand({
          id: 'cmd1',
          title: 'C',
          fn: () => {},
        });
      }
    }
    const p = new P(app, baseManifest);
    await p._activate();
    await p._deactivate();
    // 顺序:command(后入),mcp:mtool,panel(先入)
    // command 没在 log 中(它的 dispose 不写日志)— 关注我们能观察的两条
    expect(log.indexOf('mcp:mtool')).toBeLessThan(log.indexOf('panel'));
  });
});

// ────────────────────────────────────────────────────────────
// 中途 _deactivate(register await 中)
// ────────────────────────────────────────────────────────────

describe('中途 _deactivate', () => {
  it('register 已成功(disposable 已生成)后立即 _deactivate → unregister 仍触发', async () => {
    const mcp = makeFakeMcpApi();
    const app = makeAppWithMcp(mcp);
    class P extends Plugin {
      override async onload() {
        await this.registerMcpTool(makeSpec('a'));
      }
    }
    const p = new P(app, baseManifest);
    await p._activate();
    await p._deactivate();
    expect(mcp.unregisterLog).toEqual(['a']);
  });

  it('已 _deactivate 后再 registerMcpTool → register 调用,但返回的 disposable 立即 dispose', async () => {
    const mcp = makeFakeMcpApi();
    const app = makeAppWithMcp(mcp);
    let lateD: Disposable | null = null;
    class P extends Plugin {
      override onload(): void {
        /* 空 */
      }
      // 暴露受保护方法给测试
      async callLate(): Promise<Disposable> {
        lateD = await this.registerMcpTool(makeSpec('late'));
        return lateD;
      }
    }
    const p = new P(app, baseManifest);
    await p._activate();
    await p._deactivate();
    // 已 disposed
    await p.callLate();
    expect(mcp.register).toHaveBeenCalledOnce();
    // 现有 Plugin.register 在 disposed 时立即 dispose 该 d
    expect(mcp.unregisterLog).toEqual(['late']);
  });
});
