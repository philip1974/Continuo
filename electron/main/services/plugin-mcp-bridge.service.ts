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
  send(owner: PluginMcpToolOwner, channel: string, payload: unknown): void;
  /** 默认 30000ms,超时 reject INVOKE_TIMEOUT. */
  timeoutMs?: number;
  /** 注入伪造时钟用. 缺省 setTimeout. */
  setTimer?(fn: () => void, ms: number): { cancel(): void };
  /** 注入 deterministic id 用. 缺省 nano-id 风格(crypto). */
  newRequestId?(): string;
}

interface PendingEntry {
  readonly owner: PluginMcpToolOwner;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: unknown) => void;
  readonly timer: { cancel(): void };
}

export interface InvokeRemoteCore {
  invoke: InvokeRemoteFn;
  handleReply(reply: unknown): void;
  abortByWebContents(wcId: number): void;
  pendingCount(): number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

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

  const invoke: InvokeRemoteFn = (owner, name, input) =>
    new Promise<unknown>((resolve, reject) => {
      const requestId = newRequestId();
      const timer = setTimer(() => {
        if (!pending.has(requestId)) return; // 已 reply / abort
        pending.delete(requestId);
        reject(
          Object.assign(
            new Error(`plugin mcp invoke timeout after ${timeoutMs}ms`),
            { code: PLUGIN_MCP_ERROR_CODES.INVOKE_TIMEOUT },
          ),
        );
      }, timeoutMs);
      pending.set(requestId, { owner, resolve, reject, timer });
      send(owner, PLUGIN_MCP_CHANNELS.INVOKE, { requestId, name, input });
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
    const entry = pending.get(requestId);
    if (!entry) return; // 静默忽略 stale
    pending.delete(requestId);
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
    }
  };

  const abortByWebContents = (wcId: number): void => {
    for (const [requestId, entry] of pending) {
      if (entry.owner.wcId !== wcId) continue;
      pending.delete(requestId);
      entry.timer.cancel();
      entry.reject(
        Object.assign(
          new Error(`plugin webContents ${wcId} gone`),
          { code: PLUGIN_MCP_ERROR_CODES.PLUGIN_GONE },
        ),
      );
    }
  };

  return {
    invoke,
    handleReply,
    abortByWebContents,
    pendingCount: () => pending.size,
  };
}

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
}

interface BridgeEntry {
  readonly name: string;
  readonly pluginId: string;
  readonly wcId: number;
}

export function createPluginMcpBridge(
  deps: CreatePluginMcpBridgeDeps,
): PluginMcpBridge {
  const { host, invokeRemote } = deps;
  const entries = new Map<string, BridgeEntry>();

  return {
    handleRegister(wcId, payload) {
      if (entries.has(payload.name)) {
        throw Object.assign(
          new Error(`plugin mcp tool name "${payload.name}" already taken`),
          { code: PLUGIN_MCP_ERROR_CODES.TOOL_NAME_TAKEN },
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
    },

    handleUnregister(wcId, name) {
      const e = entries.get(name);
      if (!e) return; // unknown name → noop
      if (e.wcId !== wcId) return; // 非 owner wc → noop(防假冒)
      host.removeTool(name);
      entries.delete(name);
    },

    handleWebContentsGone(wcId) {
      for (const [name, e] of entries) {
        if (e.wcId !== wcId) continue;
        host.removeTool(name);
        entries.delete(name);
      }
      invokeRemote.abortByWebContents(wcId);
    },

    listRegistered() {
      return Array.from(entries.values()).map((e) => ({
        name: e.name,
        pluginId: e.pluginId,
        wcId: e.wcId,
      }));
    },
  };
}
