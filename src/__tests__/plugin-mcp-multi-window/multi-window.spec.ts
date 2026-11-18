// BDD: plugin-mcp-multi-window
// 测 main 侧 PluginMcpBridge 的多 wc 注册并存 / 路由 / wc destroyed 反注册。
// 方案 A:先到先得。
//
// 此 spec 在实装前会 red(module 不存在)。实装目标:
//   electron/main/services/plugin-mcp-bridge.service.ts 按下面 import 的形态 export。

import { describe, it, expect, vi } from 'vitest';
import {
  createPluginMcpBridge,
  type PluginMcpBridge,
  type InvokeRemoteCore,
} from '../../../electron/main/services/plugin-mcp-bridge.service';
import {
  PLUGIN_MCP_ERROR_CODES,
} from '../../../electron/shared/plugin-mcp-channels';
import type { AnyMcpTool } from '../../../electron/main/services/mcp-host.service';
import type { EnsureAuthorized } from '../../../electron/main/services/mcp-tool-gates';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { AGENT_AUTH_METHOD_MAX } from '../../../electron/shared/agent-auth-channels';

// ─── fake host ───────────────────────────────────────────────

interface FakeHost {
  readonly tools: Map<string, AnyMcpTool>;
  readonly registerCalls: AnyMcpTool[];
  readonly removeCalls: string[];
  registerTool(t: AnyMcpTool): void;
  removeTool(name: string): void;
}

function makeFakeHost(): FakeHost {
  const tools = new Map<string, AnyMcpTool>();
  const registerCalls: AnyMcpTool[] = [];
  const removeCalls: string[] = [];
  return {
    tools,
    registerCalls,
    removeCalls,
    registerTool(t) {
      registerCalls.push(t);
      tools.set(t.name, t);
    },
    removeTool(name) {
      removeCalls.push(name);
      tools.delete(name);
    },
  };
}

// ─── fake invokeRemote ──────────────────────────────────────

interface FakeInvokeRemote extends InvokeRemoteCore {
  readonly invokeCalls: { owner: { pluginId: string; wcId: number }; name: string; input: unknown }[];
  readonly abortCalls: number[];
  readonly abortToolCalls: { wcId: number; name: string }[];
  readonly rejectInvalidCalls: string[];
}

function makeFakeInvokeRemote(): FakeInvokeRemote {
  const invokeCalls: FakeInvokeRemote['invokeCalls'] = [];
  const abortCalls: number[] = [];
  const abortToolCalls: FakeInvokeRemote['abortToolCalls'] = [];
  const rejectInvalidCalls: string[] = [];
  return {
    invokeCalls,
    abortCalls,
    abortToolCalls,
    rejectInvalidCalls,
    async invoke(owner, name, input) {
      invokeCalls.push({ owner, name, input });
      return { fromOwner: owner.wcId };
    },
    handleReply: () => {},
    rejectPendingInvalid(requestId) {
      rejectInvalidCalls.push(requestId);
    },
    abortByWebContents(wcId) {
      abortCalls.push(wcId);
    },
    abortByTool(wcId, name) {
      abortToolCalls.push({ wcId, name });
    },
    pendingCount: () => 0,
  };
}

// ─── 帮手 ───────────────────────────────────────────────────

function regPayload(name: string, pluginId = 'p') {
  return {
    pluginId,
    name,
    description: `${name} desc`,
    jsonSchema: { type: 'object', additionalProperties: false },
  };
}

function makeBridge(
  ensureAuthorized: EnsureAuthorized = async () => 'once',
): {
  bridge: PluginMcpBridge;
  host: FakeHost;
  invokeRemote: FakeInvokeRemote;
  notifyCalls: number;
} {
  const host = makeFakeHost();
  const invokeRemote = makeFakeInvokeRemote();
  const counter = { n: 0 };
  const bridge = createPluginMcpBridge({
    host,
    invokeRemote,
    ensureAuthorized,
    notifyToolsChanged: () => {
      counter.n++;
    },
  });
  return {
    bridge,
    host,
    invokeRemote,
    get notifyCalls() {
      return counter.n;
    },
  };
}

// ────────────────────────────────────────────────────────────
// handleRegister · 首注册
// ────────────────────────────────────────────────────────────

describe('handleRegister · 首注册', () => {
  it('调 host.registerTool 一次,host.tools 含此 tool', () => {
    const { bridge, host } = makeBridge();
    bridge.handleRegister(11, regPayload('echo'));
    expect(host.registerCalls).toHaveLength(1);
    expect(host.registerCalls[0]!.name).toBe('echo');
    expect(host.tools.has('echo')).toBe(true);
  });

  it('内部表登 owner = (pluginId, wcId)', () => {
    const { bridge } = makeBridge();
    bridge.handleRegister(11, regPayload('echo', 'demo.alpha'));
    const list = bridge.listRegistered();
    expect(list).toEqual([{ name: 'echo', pluginId: 'demo.alpha', wcId: 11 }]);
  });

  it('listRegistered 构造快照时不通过 Array.from(values).map 生成中间数组', () => {
    const { bridge } = makeBridge();
    bridge.handleRegister(11, regPayload('a'));
    bridge.handleRegister(22, regPayload('b'));
    const fromSpy = vi.spyOn(Array, 'from');
    const mapSpy = vi.spyOn(Array.prototype, 'map');

    try {
      const list = bridge.listRegistered();

      expect(fromSpy).not.toHaveBeenCalled();
      expect(mapSpy).not.toHaveBeenCalled();
      expect(bridge.listRegistered.toString()).not.toContain(
        'registered.push(',
      );
      expect(list).toEqual([
        { name: 'a', pluginId: 'p', wcId: 11 },
        { name: 'b', pluginId: 'p', wcId: 22 },
      ]);
    } finally {
      fromSpy.mockRestore();
      mapSpy.mockRestore();
    }
  });

  it('多 wc 注册不同 name → 全部入 host.tools', () => {
    const { bridge, host } = makeBridge();
    bridge.handleRegister(11, regPayload('a'));
    bridge.handleRegister(11, regPayload('b'));
    bridge.handleRegister(22, regPayload('c'));
    expect([...host.tools.keys()].sort()).toEqual(['a', 'b', 'c']);
  });
});

// ────────────────────────────────────────────────────────────
// handleRegister · 同名冲突(方案 A 先到先得)
// ────────────────────────────────────────────────────────────

describe('handleRegister · 同名冲突', () => {
  it('同 wc 重名 → 抛 TOOL_NAME_TAKEN,host.registerTool 不再调', () => {
    const { bridge, host } = makeBridge();
    bridge.handleRegister(11, regPayload('echo'));
    const err = (() => {
      try {
        bridge.handleRegister(11, regPayload('echo'));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((err as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.TOOL_NAME_TAKEN,
    );
    expect(host.registerCalls).toHaveLength(1);
  });

  it('不同 wc 重名 → 抛 TOOL_NAME_TAKEN(全局唯一)', () => {
    const { bridge, host } = makeBridge();
    bridge.handleRegister(11, regPayload('echo', 'p.a'));
    expect(() => bridge.handleRegister(22, regPayload('echo', 'p.b'))).toThrow(
      /TOOL_NAME_TAKEN|already/i,
    );
    expect(host.registerCalls).toHaveLength(1);
    // 原 owner 不变
    expect(bridge.listRegistered()).toEqual([
      { name: 'echo', pluginId: 'p.a', wcId: 11 },
    ]);
  });

  it('冲突时不影响其他 name 注册', () => {
    const { bridge, host } = makeBridge();
    bridge.handleRegister(11, regPayload('echo'));
    try {
      bridge.handleRegister(22, regPayload('echo'));
    } catch {
      /* ignore */
    }
    bridge.handleRegister(22, regPayload('other'));
    expect([...host.tools.keys()].sort()).toEqual(['echo', 'other']);
  });
});

describe('handleRegister · 与宿主内置 tool 重名', () => {
  // 安全:host.tools 已含内置 tool(terminal.* / debug.* 等,非桥登记)。插件注册同名必须拒绝,
  // 否则 Map.set 覆盖 → 外部 agent 的核心工具被插件截获;插件注销时 removeTool 又把该名字删掉 →
  // 内置工具永久 NO_SUCH_TOOL。
  function builtin(name: string): AnyMcpTool {
    return { name, description: 'builtin', jsonSchema: {}, run: () => ({ builtin: true }) } as unknown as AnyMcpTool;
  }

  it('预置内置 tool 后插件注册同名 → 抛 TOOL_NAME_TAKEN,内置 tool 不被覆盖', () => {
    const { bridge, host } = makeBridge();
    const orig = builtin('terminal.list_sessions');
    host.tools.set(orig.name, orig);
    const err = (() => {
      try {
        bridge.handleRegister(11, regPayload('terminal.list_sessions'));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((err as { code?: string } | null)?.code).toBe(PLUGIN_MCP_ERROR_CODES.TOOL_NAME_TAKEN);
    expect(host.registerCalls).toHaveLength(0);
    expect(host.tools.get('terminal.list_sessions')).toBe(orig);
    expect(bridge.listRegistered()).toEqual([]);
  });

  it('被拒后插件注销 / wc 销毁 → 不删内置 tool', () => {
    const { bridge, host } = makeBridge();
    const orig = builtin('debug.launch');
    host.tools.set(orig.name, orig);
    try {
      bridge.handleRegister(11, regPayload('debug.launch'));
    } catch {
      /* ignore */
    }
    bridge.handleUnregister(11, 'debug.launch');
    bridge.handleWebContentsGone(11);
    expect(host.removeCalls).toEqual([]);
    expect(host.tools.get('debug.launch')).toBe(orig);
  });
});

// ────────────────────────────────────────────────────────────
// handleUnregister
// ────────────────────────────────────────────────────────────

describe('handleUnregister', () => {
  it('owner wc 调 unregister → 调 host.removeTool,内部表摘', () => {
    const { bridge, host } = makeBridge();
    bridge.handleRegister(11, regPayload('echo'));
    bridge.handleUnregister(11, 'echo');
    expect(host.removeCalls).toEqual(['echo']);
    expect(host.tools.has('echo')).toBe(false);
    expect(bridge.listRegistered()).toEqual([]);
  });

  it('owner wc 调 unregister → abort 该 (wcId,name) 在途 invoke(topic49 6thS)', () => {
    const { bridge, invokeRemote } = makeBridge();
    bridge.handleRegister(11, regPayload('echo'));
    bridge.handleUnregister(11, 'echo');
    // 与 handleWebContentsGone 的 abortByWebContents 对称:摘 tool 后 abort 在途 invoke,
    // 否则 agent 侧 tools/call 要干等满 30s timeout。
    expect(invokeRemote.abortToolCalls).toEqual([{ wcId: 11, name: 'echo' }]);
  });

  it('非 owner / unknown unregister → 不 abort(不误伤)', () => {
    const { bridge, invokeRemote } = makeBridge();
    bridge.handleRegister(11, regPayload('echo'));
    bridge.handleUnregister(22, 'echo'); // 假冒
    bridge.handleUnregister(11, 'ghost'); // 不存在
    expect(invokeRemote.abortToolCalls).toEqual([]);
  });

  it('unknown name → 静默 noop,不抛', () => {
    const { bridge, host } = makeBridge();
    expect(() => bridge.handleUnregister(11, 'ghost')).not.toThrow();
    expect(host.removeCalls).toEqual([]);
  });

  it('已 unregister 后再 unregister → noop', () => {
    const { bridge, host } = makeBridge();
    bridge.handleRegister(11, regPayload('echo'));
    bridge.handleUnregister(11, 'echo');
    expect(() => bridge.handleUnregister(11, 'echo')).not.toThrow();
    expect(host.removeCalls).toEqual(['echo']);
  });

  it('非 owner wc 调 unregister → noop,不影响原 owner', () => {
    const { bridge, host } = makeBridge();
    bridge.handleRegister(11, regPayload('echo'));
    bridge.handleUnregister(22, 'echo'); // 假冒
    expect(host.removeCalls).toEqual([]);
    expect(host.tools.has('echo')).toBe(true);
    expect(bridge.listRegistered()).toEqual([
      { name: 'echo', pluginId: 'p', wcId: 11 },
    ]);
  });
});

// ────────────────────────────────────────────────────────────
// handleWebContentsGone
// ────────────────────────────────────────────────────────────

describe('handleWebContentsGone', () => {
  it('摘掉所有 owner=该 wc 的 stub', () => {
    const { bridge, host } = makeBridge();
    bridge.handleRegister(11, regPayload('a'));
    bridge.handleRegister(11, regPayload('b'));
    bridge.handleRegister(22, regPayload('c'));
    bridge.handleWebContentsGone(11);
    expect([...host.tools.keys()]).toEqual(['c']);
    expect(bridge.listRegistered()).toEqual([
      { name: 'c', pluginId: 'p', wcId: 22 },
    ]);
  });

  it('调 invokeRemote.abortByWebContents(wcId)', () => {
    const { bridge, invokeRemote } = makeBridge();
    bridge.handleRegister(11, regPayload('a'));
    bridge.handleWebContentsGone(11);
    expect(invokeRemote.abortCalls).toEqual([11]);
  });

  it('gone 后允许其他 wc 重注册同名(name 已腾出)', () => {
    const { bridge, host } = makeBridge();
    bridge.handleRegister(11, regPayload('echo', 'p.a'));
    bridge.handleWebContentsGone(11);
    expect(() => bridge.handleRegister(22, regPayload('echo', 'p.b'))).not.toThrow();
    expect(bridge.listRegistered()).toEqual([
      { name: 'echo', pluginId: 'p.b', wcId: 22 },
    ]);
    expect(host.registerCalls).toHaveLength(2);
  });

  it('gone 不存在的 wcId → noop,不影响别的 wc', () => {
    const { bridge, host } = makeBridge();
    bridge.handleRegister(11, regPayload('echo'));
    expect(() => bridge.handleWebContentsGone(999)).not.toThrow();
    expect(host.tools.has('echo')).toBe(true);
  });

  it('gone 多个 wc 顺序处理(每个独立)', () => {
    const { bridge, host, invokeRemote } = makeBridge();
    bridge.handleRegister(11, regPayload('a'));
    bridge.handleRegister(22, regPayload('b'));
    bridge.handleWebContentsGone(11);
    bridge.handleWebContentsGone(22);
    expect(host.tools.size).toBe(0);
    expect(invokeRemote.abortCalls).toEqual([11, 22]);
  });
});

// ────────────────────────────────────────────────────────────
// 路由正确性 — stub.run 把正确 owner 透给 invokeRemote
// ────────────────────────────────────────────────────────────

describe('路由正确性', () => {
  it('调 stub.run → invokeRemote.invoke 收到注册者 owner', async () => {
    const { bridge, host, invokeRemote } = makeBridge();
    bridge.handleRegister(11, regPayload('a', 'p.alpha'));
    bridge.handleRegister(22, regPayload('b', 'p.beta'));
    const stubA = host.tools.get('a')!;
    const stubB = host.tools.get('b')!;
    const ctx = { ownerWindowId: 1 };
    await stubA.run({ x: 1 }, ctx);
    await stubB.run({ x: 2 }, ctx);
    expect(invokeRemote.invokeCalls).toEqual([
      { owner: { pluginId: 'p.alpha', wcId: 11 }, name: 'a', input: { x: 1 } },
      { owner: { pluginId: 'p.beta', wcId: 22 }, name: 'b', input: { x: 2 } },
    ]);
  });

  it('stub.run 在 wc gone 后不再可达(stub 已从 host 摘)', () => {
    const { bridge, host } = makeBridge();
    bridge.handleRegister(11, regPayload('a'));
    bridge.handleWebContentsGone(11);
    expect(host.tools.get('a')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
// 授权门控 — 插件工具与终端 / debug 工具同走 agent 授权(独立 plugin 域)
// 安全:此前 stub.run 丢弃 ctx 直接 invoke,用户对 agent 点了「拒绝」仍可调插件工具(如 git stage/commit)。
// ────────────────────────────────────────────────────────────

describe('授权门控 · 插件工具经 agent 授权', () => {
  it('用户拒绝 → AGENT_NOT_AUTHORIZED,不向插件 renderer 发 invoke', async () => {
    const { bridge, host, invokeRemote } = makeBridge(async () => 'denied');
    bridge.handleRegister(11, regPayload('git.stage', 'p.git'));
    await expect(
      host.tools.get('git.stage')!.run({}, { ownerWindowId: 1 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.AGENT_NOT_AUTHORIZED });
    expect(invokeRemote.invokeCalls).toEqual([]);
  });

  it('授权以调用方窗口(ctx.ownerWindowId)为准,method 归 plugin 域(plugin.<tool 名>)', async () => {
    const ensure = vi.fn<EnsureAuthorized>(async () => 'once');
    const { bridge, host, invokeRemote } = makeBridge(ensure);
    // 工具由 wc 11 注册,调用方是窗口 2 的 agent:跨窗先到先得照常路由到注册者,授权弹在调用方窗口
    bridge.handleRegister(11, regPayload('git.commit', 'p.git'));
    await host.tools.get('git.commit')!.run({ m: 'x' }, { ownerWindowId: 2 });
    expect(ensure).toHaveBeenCalledWith(2, 'plugin.git.commit', false);
    expect(invokeRemote.invokeCalls).toEqual([
      { owner: { pluginId: 'p.git', wcId: 11 }, name: 'git.commit', input: { m: 'x' } },
    ]);
  });

  it('调用方已断开 → 不弹授权、不 invoke', async () => {
    const ensure = vi.fn<EnsureAuthorized>(async () => 'once');
    const { bridge, host, invokeRemote } = makeBridge(ensure);
    bridge.handleRegister(11, regPayload('a'));
    const ac = new AbortController();
    ac.abort();
    await expect(
      host.tools.get('a')!.run({}, { ownerWindowId: 1, signal: ac.signal }),
    ).rejects.toMatchObject({ code: ERROR_CODES.AGENT_NOT_AUTHORIZED });
    expect(ensure).not.toHaveBeenCalled();
    expect(invokeRemote.invokeCalls).toEqual([]);
  });

  it('超长 tool 名 → method 截到授权请求 method 上限内(弹窗不因超长被 renderer 丢弃)', async () => {
    const ensure = vi.fn<EnsureAuthorized>(async () => 'once');
    const { bridge, host } = makeBridge(ensure);
    const longName = 'x'.repeat(256);
    bridge.handleRegister(11, regPayload(longName));
    await host.tools.get(longName)!.run({}, { ownerWindowId: 1 });
    const method = ensure.mock.calls[0]![1]!;
    expect(method.startsWith('plugin.')).toBe(true);
    expect(method.length).toBeLessThanOrEqual(AGENT_AUTH_METHOD_MAX);
  });
});

// ────────────────────────────────────────────────────────────
// notifyToolsChanged — MCP `notifications/tools/list_changed` 钩子
// ────────────────────────────────────────────────────────────

describe('notifyToolsChanged · 钩子触发时机', () => {
  it('handleRegister 成功 → 调一次', () => {
    const h = makeBridge();
    h.bridge.handleRegister(11, regPayload('a'));
    expect(h.notifyCalls).toBe(1);
  });

  it('handleRegister 抛 TOOL_NAME_TAKEN → 不调(失败不通知)', () => {
    const h = makeBridge();
    h.bridge.handleRegister(11, regPayload('a'));
    expect(h.notifyCalls).toBe(1);
    try {
      h.bridge.handleRegister(22, regPayload('a'));
    } catch {
      /* ignore */
    }
    expect(h.notifyCalls).toBe(1); // 仍是 1,失败不增
  });

  it('handleUnregister 命中 → 调一次', () => {
    const h = makeBridge();
    h.bridge.handleRegister(11, regPayload('a'));
    h.bridge.handleUnregister(11, 'a');
    expect(h.notifyCalls).toBe(2); // register 1 + unregister 1
  });

  it('handleUnregister unknown name → 不调(noop 不通知)', () => {
    const h = makeBridge();
    h.bridge.handleUnregister(11, 'ghost');
    expect(h.notifyCalls).toBe(0);
  });

  it('handleUnregister 非 owner wc → 不调(假冒拒绝不通知)', () => {
    const h = makeBridge();
    h.bridge.handleRegister(11, regPayload('a'));
    h.bridge.handleUnregister(22, 'a'); // 非 owner
    expect(h.notifyCalls).toBe(1); // 仅 register 那次
  });

  it('handleWebContentsGone 摘掉 N 个 tool → 调一次(批量去重)', () => {
    const h = makeBridge();
    h.bridge.handleRegister(11, regPayload('a'));
    h.bridge.handleRegister(11, regPayload('b'));
    h.bridge.handleRegister(11, regPayload('c'));
    expect(h.notifyCalls).toBe(3);
    h.bridge.handleWebContentsGone(11);
    expect(h.notifyCalls).toBe(4); // gone 整体一次,不是按 tool 计数
  });

  it('handleWebContentsGone 没摘到 tool → 不调', () => {
    const h = makeBridge();
    h.bridge.handleWebContentsGone(999); // 该 wc 没注册过
    expect(h.notifyCalls).toBe(0);
  });

  it('notifyToolsChanged 未注入 → 不抛错(可选 deps)', () => {
    const host = makeFakeHost();
    const invokeRemote = makeFakeInvokeRemote();
    const bridge = createPluginMcpBridge({
      host,
      invokeRemote,
      ensureAuthorized: async () => 'once',
    });
    expect(() => bridge.handleRegister(11, regPayload('a'))).not.toThrow();
    expect(() => bridge.handleUnregister(11, 'a')).not.toThrow();
    expect(() => bridge.handleWebContentsGone(11)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────
// 边界(E79):注册 tool 数量上限(per-wc + 全局),防海量注册撑爆 main + 广播放大
// ────────────────────────────────────────────────────────────

describe('handleRegister · 数量上限(E79)', () => {
  it('单 wc 超 256 tool → 抛 TOO_MANY_TOOLS,host.registerTool 不再调', () => {
    const { bridge, host } = makeBridge();
    for (let i = 0; i < 256; i += 1) {
      bridge.handleRegister(11, regPayload(`t${i}`));
    }
    expect(host.tools.size).toBe(256);
    let thrown: unknown;
    try {
      bridge.handleRegister(11, regPayload('overflow'));
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.TOO_MANY_TOOLS,
    );
    expect(host.tools.size).toBe(256); // 未注册第 257 个
  });

  it('unregister 释放 per-wc 名额 → 可再注册', () => {
    const { bridge } = makeBridge();
    for (let i = 0; i < 256; i += 1) {
      bridge.handleRegister(11, regPayload(`t${i}`));
    }
    bridge.handleUnregister(11, 't0'); // 腾 1 个
    expect(() => bridge.handleRegister(11, regPayload('again'))).not.toThrow();
  });

  it('wcGone 释放整 wc 名额 → 可再注册', () => {
    const { bridge } = makeBridge();
    for (let i = 0; i < 256; i += 1) {
      bridge.handleRegister(11, regPayload(`t${i}`));
    }
    bridge.handleWebContentsGone(11); // 整 wc 清空
    expect(() => bridge.handleRegister(11, regPayload('fresh'))).not.toThrow();
  });

  it('全局超 2048 tool(跨多 wc)→ 抛 TOO_MANY_TOOLS', () => {
    const { bridge } = makeBridge();
    // 8 wc × 256 = 2048 填满全局上限(每 wc 不超 per-wc 上限)
    for (let w = 0; w < 8; w += 1) {
      for (let i = 0; i < 256; i += 1) {
        bridge.handleRegister(w, regPayload(`w${w}_t${i}`));
      }
    }
    let thrown: unknown;
    try {
      bridge.handleRegister(99, regPayload('global-overflow'));
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.TOO_MANY_TOOLS,
    );
  });
});

// 让 vi 被 import,免 lint 抱怨
void vi;
