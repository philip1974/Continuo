// Plugin → MCP Bridge — main 侧。
//
// 三块内容:
// 1. createStubTool(spec, owner, invoke) — 把 plugin 上送的元数据包成 McpToolDef,
//    inputSchema=z.unknown()(校验留 renderer);run(input) → invoke(owner, name, input)
// 2. createInvokeRemote(deps) — 反向调用核心:发 IPC + pending map + 超时 + reply 路由 + abort
// 3. createPluginMcpBridge(deps) — register/unregister/wcGone 路由,host.tools 增删
//
// BDD:
//   src/__tests__/plugin-mcp-stub-tool/(1+2)
//   src/__tests__/plugin-mcp-multi-window/(3)
//   src/__tests__/plugin-mcp-e2e/(集成)

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  PLUGIN_MCP_CHANNELS,
  PLUGIN_MCP_ERROR_CODES,
} from '../../shared/plugin-mcp-channels';
import type { AnyMcpTool } from './mcp-host.service';

// ── 类型 ────────────────────────────────────────────────────

export interface PluginMcpToolOwner {
  readonly pluginId: string;
  readonly wcId: number;
}

export interface PluginMcpRegistrationSpec {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Record<string, unknown>;
}

export type InvokeRemoteFn = (
  owner: PluginMcpToolOwner,
  name: string,
  input: unknown,
) => Promise<unknown>;

// ── createStubTool ─────────────────────────────────────────

/**
 * 把 plugin 上送的元数据包成 McpToolDef。inputSchema 用 z.unknown()——
 * main 端不校验输入(plugin 自定义 zod 校验放 renderer 端 PluginMcpRegistry.invokeLocal)。
 */
export function createStubTool(
  spec: PluginMcpRegistrationSpec,
  owner: PluginMcpToolOwner,
  invoke: InvokeRemoteFn,
): AnyMcpTool {
  return {
    name: spec.name,
    description: spec.description,
    jsonSchema: spec.jsonSchema,
    inputSchema: z.unknown(),
    run: (input: unknown) => invoke(owner, spec.name, input),
  };
}

// ── createInvokeRemote ─────────────────────────────────────

export interface CreateInvokeRemoteDeps {
  // race(R32):返回是否真正投递。wc 已销毁/不可达时返 false → invoke 立即清 pending + reject
  // PLUGIN_GONE,不让 pending 干等满 timeout(外部 agent tools/call 卡 30s)。返 false 而非
  // 静默 no-op 是关键:登记 pending 与 send 之间窗口里 wc 可能已 destroyed-cleanup 跑完,
  // 此次新 pending 无人 abort。返 void(旧契约/测试桩)视作已投递(=== false 才判失败)。
  send(owner: PluginMcpToolOwner, channel: string, payload: unknown): boolean | void;
  /** 默认 30000ms,超时 reject INVOKE_TIMEOUT. */
  timeoutMs?: number;
  /** 注入伪造时钟用. 缺省 setTimeout. */
  setTimer?(fn: () => void, ms: number): { cancel(): void };
  /** 注入 deterministic id 用. 缺省 nano-id 风格(crypto). */
  newRequestId?(): string;
}

interface PendingEntry {
  readonly owner: PluginMcpToolOwner;
  readonly name: string;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: unknown) => void;
  readonly timer: { cancel(): void };
}

export interface InvokeRemoteCore {
  invoke: InvokeRemoteFn;
  handleReply(reply: unknown): void;
  /** 边界(E265):按 requestId 用固定 INVALID_REPLY 拒绝 pending,不读 raw payload(校验失败 fallback). */
  rejectPendingInvalid(requestId: string): void;
  abortByWebContents(wcId: number): void;
  /** 某 tool 被其 owner wc unregister 时,abort 该 (wcId,name) 的所有在途 invoke. */
  abortByTool(wcId: number, name: string): void;
  pendingCount(): number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// 边界(E228,E227/E79 in-flight 数量上限族):反向 invoke 的在途(pending)数量上限。每次 invoke 在
// pending Map 登记一条 + 起 30s timer + 向 renderer 发 IPC;此前只对单次 input/result 大小设限(E125
// 等),无在途数量上限 —— 外部 MCP client 可并发 spam 海量 tools/call 到同一 plugin tool,累计 pending +
// timer + IPC 放大 main 内存/事件循环压力。全局 + per-webContents 双闸(对齐 E227 ScopeRequestCorrelator),
// 超限立即 reject TOO_MANY_REQUESTS,不入 pending、不起 timer、不发 IPC。per-wc 上限同时透传约束单 tool
// spam(一个 tool 归属唯一 wc,其在途数 ≤ 该 wc 在途上限,无需再加 per-tool 维度)。
const MAX_INFLIGHT_INVOKES_GLOBAL = 512; // 全局在途上限(远超任何正常并发调用)
const MAX_INFLIGHT_INVOKES_PER_WC = 128; // 单窗口在途上限

const defaultSetTimer = (fn: () => void, ms: number) => {
  const id = setTimeout(fn, ms);
  return {
    cancel() {
      clearTimeout(id);
    },
  };
};

const defaultNewRequestId = () => randomBytes(8).toString('base64url');

export function createInvokeRemote(
  deps: CreateInvokeRemoteDeps,
): InvokeRemoteCore {
  const { send } = deps;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const newRequestId = deps.newRequestId ?? defaultNewRequestId;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const pending = new Map<string, PendingEntry>();
  // 边界(E228):per-wc 在途计数(O(1) 维护,避免每次 invoke 遍历 pending 数 wc → O(n))。
  const inflightPerWc = new Map<number, number>();
  const incWc = (wcId: number): void => {
    inflightPerWc.set(wcId, (inflightPerWc.get(wcId) ?? 0) + 1);
  };
  const decWc = (wcId: number): void => {
    const n = (inflightPerWc.get(wcId) ?? 0) - 1;
    if (n > 0) inflightPerWc.set(wcId, n);
    else inflightPerWc.delete(wcId); // Map 排空回收,防 wc 计数项泄漏
  };
  // 边界(E228):单一删除收口 —— 删 pending + 同步减 per-wc 计数。所有终态路径(reply / timeout /
  // abort / send-fail)都走这里,防计数漂移导致上限误判(永久卡死后续 invoke)。返回被删 entry(或 undefined)。
  const removePending = (requestId: string): PendingEntry | undefined => {
    const entry = pending.get(requestId);
    if (!entry) return undefined;
    pending.delete(requestId);
    decWc(entry.owner.wcId);
    return entry;
  };

  const invoke: InvokeRemoteFn = (owner, name, input) =>
    new Promise<unknown>((resolve, reject) => {
      // 边界(E228):在途数量双闸,超限立即 reject,不入 pending、不起 timer、不发 IPC。
      if (pending.size >= MAX_INFLIGHT_INVOKES_GLOBAL) {
        reject(
          Object.assign(
            new Error(
              `plugin mcp in-flight invoke limit (${MAX_INFLIGHT_INVOKES_GLOBAL}) reached`,
            ),
            { code: PLUGIN_MCP_ERROR_CODES.TOO_MANY_REQUESTS },
          ),
        );
        return;
      }
      if ((inflightPerWc.get(owner.wcId) ?? 0) >= MAX_INFLIGHT_INVOKES_PER_WC) {
        reject(
          Object.assign(
            new Error(
              `plugin mcp per-window in-flight invoke limit (${MAX_INFLIGHT_INVOKES_PER_WC}) reached`,
            ),
            { code: PLUGIN_MCP_ERROR_CODES.TOO_MANY_REQUESTS },
          ),
        );
        return;
      }
      const requestId = newRequestId();
      const timer = setTimer(() => {
        if (!removePending(requestId)) return; // 已 reply / abort
        reject(
          Object.assign(
            new Error(`plugin mcp invoke timeout after ${timeoutMs}ms`),
            { code: PLUGIN_MCP_ERROR_CODES.INVOKE_TIMEOUT },
          ),
        );
      }, timeoutMs);
      pending.set(requestId, { owner, name, resolve, reject, timer });
      incWc(owner.wcId); // 边界(E228):登记即计数,与 removePending 的 decWc 对偶
      // race(R32):send 显式返 false(wc 已销毁/不可达)或抛错 → 立即清本次 pending + cancel
      // timer + reject PLUGIN_GONE,不静默等满 timeout。返 void/true 视作已投递(向后兼容)。
      let delivered: boolean | void;
      try {
        delivered = send(owner, PLUGIN_MCP_CHANNELS.INVOKE, { requestId, name, input });
      } catch (err) {
        if (removePending(requestId)) {
          timer.cancel();
          reject(
            Object.assign(
              err instanceof Error ? err : new Error('plugin mcp send threw'),
              { code: PLUGIN_MCP_ERROR_CODES.PLUGIN_GONE },
            ),
          );
        }
        return;
      }
      if (delivered === false && removePending(requestId)) {
        timer.cancel();
        reject(
          Object.assign(new Error('plugin mcp target webContents gone'), {
            code: PLUGIN_MCP_ERROR_CODES.PLUGIN_GONE,
          }),
        );
      }
    });

  const handleReply = (reply: unknown): void => {
    if (
      reply === null ||
      typeof reply !== 'object' ||
      Array.isArray(reply)
    ) {
      return; // 协议层应已校,这里防御性
    }
    const r = reply as Record<string, unknown>;
    const requestId = r['requestId'];
    if (typeof requestId !== 'string') return;
    const entry = removePending(requestId);
    if (!entry) return; // 静默忽略 stale
    entry.timer.cancel();
    if (r['ok'] === true) {
      entry.resolve(r['result']);
      return;
    }
    if (r['ok'] === false) {
      const code =
        typeof r['code'] === 'string' ? r['code'] : 'UNKNOWN';
      const message =
        typeof r['message'] === 'string' ? r['message'] : 'unknown error';
      entry.reject(Object.assign(new Error(message), { code }));
      return;
    }
    // 畸形 reply:ok 既非 true 也非 false(缺失/null/字符串/数字)。此时上面已
    // cancel timer + 删 pending,若直接 return 则该 invoke 永久挂起(连 timeout
    // 兜底都被 cancel 了)。必须显式 reject,否则 agent 的 tools/call 永不返回。
    entry.reject(
      Object.assign(new Error('malformed plugin mcp reply (missing ok)'), {
        code: PLUGIN_MCP_ERROR_CODES.INVALID_REPLY,
      }),
    );
  };

  const abortByWebContents = (wcId: number): void => {
    for (const [requestId, entry] of pending) {
      if (entry.owner.wcId !== wcId) continue;
      removePending(requestId);
      entry.timer.cancel();
      entry.reject(
        Object.assign(
          new Error(`plugin webContents ${wcId} gone`),
          { code: PLUGIN_MCP_ERROR_CODES.PLUGIN_GONE },
        ),
      );
    }
  };

  const abortByTool = (wcId: number, name: string): void => {
    for (const [requestId, entry] of pending) {
      if (entry.owner.wcId !== wcId || entry.name !== name) continue;
      removePending(requestId);
      entry.timer.cancel();
      entry.reject(
        Object.assign(new Error(`plugin mcp tool "${name}" unregistered`), {
          code: PLUGIN_MCP_ERROR_CODES.TOOL_DISPOSED,
        }),
      );
    }
  };

  // 边界(E265,E263 main 侧对偶 / 读端独立校验):INVOKE_REPLY 的 bounded/schema 校验失败时,**不**把 raw
  // reply 整体交 handleReply —— handleReply 信任 raw 的 ok/result/message/code:ok:true→resolve 超大
  // result、ok:false→reject 超长 message,均绕过 InvokeReplySchema 的 10MB/8192/256 上限,经 mcp-host
  // 编进 JSON-RPC 响应放大 main 内存/输出。renderer bridge(E262/E263)已发送端裁剪,但恶意/绕过 bridge 的
  // renderer 可直接发畸形 raw reply,main 须独立防御。改为仅按 requestId 用固定 INVALID_REPLY 拒绝对应
  // pending(不读任何 raw payload 字段),既收口 pending 不挂 30s,又绝不传播 raw 超大/超长字段。
  const rejectPendingInvalid = (requestId: string): void => {
    const entry = removePending(requestId);
    if (!entry) return; // stale / 无此 pending
    entry.timer.cancel();
    entry.reject(
      Object.assign(new Error('invalid plugin mcp reply (failed validation)'), {
        code: PLUGIN_MCP_ERROR_CODES.INVALID_REPLY,
      }),
    );
  };

  return {
    invoke,
    handleReply,
    rejectPendingInvalid,
    abortByWebContents,
    abortByTool,
    pendingCount: () => pending.size,
  };
}

// 边界(E228)测试用:在途上限常量。
export const MAX_INFLIGHT_INVOKES_GLOBAL_FOR_TEST = MAX_INFLIGHT_INVOKES_GLOBAL;
export const MAX_INFLIGHT_INVOKES_PER_WC_FOR_TEST = MAX_INFLIGHT_INVOKES_PER_WC;

// ── createPluginMcpBridge ──────────────────────────────────

export interface PluginMcpBridge {
  /** renderer 上行注册一次。重名抛错;成功则在 host.tools 加 stub. */
  handleRegister(
    wcId: number,
    payload: {
      pluginId: string;
      name: string;
      description: string;
      jsonSchema: Record<string, unknown>;
    },
  ): void;
  /** renderer 上行摘掉。unknown name / non-owner wc 静默 noop. */
  handleUnregister(wcId: number, name: string): void;
  /** webContents destroyed:摘所有 owner=该 wc 的 stub + abort 所有该 wc 的 pending invoke. */
  handleWebContentsGone(wcId: number): void;
  /** 测试用:列当前注册. */
  listRegistered(): readonly { name: string; pluginId: string; wcId: number }[];
}

export interface PluginMcpBridgeHost {
  registerTool(t: AnyMcpTool): void;
  removeTool(name: string): void;
  readonly tools: ReadonlyMap<string, AnyMcpTool>;
}

export interface CreatePluginMcpBridgeDeps {
  host: PluginMcpBridgeHost;
  invokeRemote: InvokeRemoteCore;
  /**
   * 可选:tool 集变更时调(register / unregister / wcGone 摘到 tool)。
   * 调用方可在此触发 MCP `notifications/tools/list_changed` 推给所有
   * MCP client(HTTP SSE / stdio sock)。失败 / unknown / 假冒 等不调。
   */
  notifyToolsChanged?: () => void;
}

interface BridgeEntry {
  readonly name: string;
  readonly pluginId: string;
  readonly wcId: number;
}

// 边界(E79,E54/E47 注册表数量上限族):单 webContents / 全局注册 tool 数量上限。此前 handleRegister
// 只校验单个 tool 的 name/description/jsonSchema 大小(E53),无数量上限 —— 恶意插件可循环注册成千上万
// 个合法小 tool,主进程 entries/host.tools 持续增长,tools/list 与 list_changed 广播输出被放大到卡顿/
// OOM。每 wc 维护 O(1) 计数,register 前查 per-wc + 全局上限,超限抛 TOO_MANY_TOOLS。
const MAX_TOOLS_PER_WC = 256;
const MAX_TOOLS_GLOBAL = 2048;

export function createPluginMcpBridge(
  deps: CreatePluginMcpBridgeDeps,
): PluginMcpBridge {
  const { host, invokeRemote, notifyToolsChanged } = deps;
  const entries = new Map<string, BridgeEntry>();
  // 边界(E79):per-wc 注册计数(O(1) 维护,避免 register 时 O(n) 遍历 entries 数 wc 计数 → O(n²))。
  const perWcCount = new Map<number, number>();
  // 减计数并在归零时删 key(Map 排空回收,防 wc 计数项泄漏)。
  const decrementWc = (wcId: number): void => {
    const n = (perWcCount.get(wcId) ?? 0) - 1;
    if (n > 0) perWcCount.set(wcId, n);
    else perWcCount.delete(wcId);
  };

  return {
    handleRegister(wcId, payload) {
      if (entries.has(payload.name)) {
        throw Object.assign(
          new Error(`plugin mcp tool name "${payload.name}" already taken`),
          { code: PLUGIN_MCP_ERROR_CODES.TOOL_NAME_TAKEN },
        );
      }
      // 边界(E79):全局 + per-wc 数量上限,超限拒注册(防海量注册撑爆 main + 广播放大)。
      if (entries.size >= MAX_TOOLS_GLOBAL) {
        throw Object.assign(
          new Error(`plugin mcp global tool limit (${MAX_TOOLS_GLOBAL}) reached`),
          { code: PLUGIN_MCP_ERROR_CODES.TOO_MANY_TOOLS },
        );
      }
      if ((perWcCount.get(wcId) ?? 0) >= MAX_TOOLS_PER_WC) {
        throw Object.assign(
          new Error(
            `plugin mcp per-window tool limit (${MAX_TOOLS_PER_WC}) reached`,
          ),
          { code: PLUGIN_MCP_ERROR_CODES.TOO_MANY_TOOLS },
        );
      }
      const owner: PluginMcpToolOwner = {
        pluginId: payload.pluginId,
        wcId,
      };
      const stub = createStubTool(
        {
          name: payload.name,
          description: payload.description,
          jsonSchema: payload.jsonSchema,
        },
        owner,
        invokeRemote.invoke,
      );
      host.registerTool(stub);
      entries.set(payload.name, {
        name: payload.name,
        pluginId: payload.pluginId,
        wcId,
      });
      perWcCount.set(wcId, (perWcCount.get(wcId) ?? 0) + 1); // 边界(E79)
      notifyToolsChanged?.();
    },

    handleUnregister(wcId, name) {
      const e = entries.get(name);
      if (!e) return; // unknown name → noop
      if (e.wcId !== wcId) return; // 非 owner wc → noop(防假冒)
      host.removeTool(name);
      entries.delete(name);
      decrementWc(wcId); // 边界(E79):同步 per-wc 计数
      // 该 tool 还在途的 invoke 必须立即 abort —— 否则 renderer 端 stub 已没,
      // reply 永不回来,agent 侧 tools/call 要干等满 30s timeout 才自愈。与
      // handleWebContentsGone 的 abortByWebContents 对称(那条整 wc 销毁也 abort)。
      invokeRemote.abortByTool(wcId, name);
      notifyToolsChanged?.();
    },

    handleWebContentsGone(wcId) {
      let removed = 0;
      for (const [name, e] of entries) {
        if (e.wcId !== wcId) continue;
        host.removeTool(name);
        entries.delete(name);
        removed++;
      }
      perWcCount.delete(wcId); // 边界(E79):整 wc 销毁,计数清零(Map 排空回收,防泄漏)
      invokeRemote.abortByWebContents(wcId);
      // 整批去重通知(N 个 tool 一次 notify,不是 N 次)。
      // 没摘到 tool 不通知(可能 wc 从未 register 过)。
      if (removed > 0) notifyToolsChanged?.();
    },

    listRegistered() {
      const registered = new Array<{
        name: string;
        pluginId: string;
        wcId: number;
      }>(entries.size);
      let registeredCount = 0;
      for (const e of entries.values()) {
        registered[registeredCount] = {
          name: e.name,
          pluginId: e.pluginId,
          wcId: e.wcId,
        };
        registeredCount += 1;
      }
      return registered;
    },
  };
}
