// Plugin → MCP Bridge — IPC handler 接线(main 侧)。
// 把 renderer ↔ main bridge 的内存接口转成真 ipcMain handle / on + webContents.send。
//
// 三个 channel:
//   plugin-mcp:register   (renderer → main, invoke + IpcResult)
//   plugin-mcp:unregister (renderer → main, invoke + IpcResult)
//   plugin-mcp:invoke-reply (renderer → main, send + on, no reply)
// 一个反向推:
//   plugin-mcp:invoke (main → renderer, webContents.send)
//
// 配套 doc/19-plugin-mcp-bridge.md。

import {
  BrowserWindow,
  ipcMain,
  webContents,
} from 'electron';
import { defaultIsTrustedFrame, safeHandleWithCtx } from '../safe-handle';
import { boundedObjectAdmissible } from '../../shared/bounded-input';
import { PLUGIN_MCP_CHANNELS } from '../../shared/plugin-mcp-channels';
import {
  RegisterPayloadSchema,
  UnregisterPayloadSchema,
  InvokeReplySchema,
} from '../../shared/plugin-mcp-schemas';
import {
  createInvokeRemote,
  createPluginMcpBridge,
  type InvokeRemoteCore,
  type PluginMcpBridge,
  type PluginMcpToolOwner,
} from '../services/plugin-mcp-bridge.service';
import type { McpHost } from '../services/mcp-host.service';
import type { EnsureAuthorized } from '../services/mcp-tool-gates';
import type { StdioSocketServer } from '../services/mcp-stdio-server.service';
import { makeWcGoneHook } from '../lib/wc-gone-hook';
import { createTrailingNotifier } from '../lib/trailing-notifier';

/** MCP 标准 method:tool 集变更通知. */
const TOOLS_LIST_CHANGED = 'notifications/tools/list_changed';
const TOOLS_LIST_CHANGED_COALESCE_MS = 50;

// ── 内部状态(模块级单例) ────────────────────────────────────

let bridge: PluginMcpBridge | null = null;
let invokeRemote: InvokeRemoteCore | null = null;

/**
 * 启动 plugin → MCP bridge IPC 接线。
 * 在 startMcpHost 之后调,host 已就绪。
 *
 * - 注 ipcMain.handle PLUGIN_MCP_CHANNELS.REGISTER / UNREGISTER(invoke + IpcResult)
 * - 注 ipcMain.on PLUGIN_MCP_CHANNELS.INVOKE_REPLY(send + 无回应)
 * - send 用 webContents.fromId(wcId).send(...);wc destroyed → handleWebContentsGone
 * - bridge tool 集变更 → 推 `notifications/tools/list_changed` 给所有 SSE
 *   + stdio 客户端,Codex / Claude Code 收到后自动重拉 tools/list
 */
export function startPluginMcpIpc(
  host: McpHost,
  // 取值函数而非快照:stdio server 在首窗创建后才异步启动(冷启动不挡建窗),就绪前返回 null →
  // 广播只推 HTTP;就绪后每次广播读到最新引用。
  getStdio: () => StdioSocketServer | null = () => null,
  // 安全:插件工具 agent 授权门控。缺省 fail-closed(一律拒绝),生产由 main/index.ts 注入 requestAgentAuth。
  ensureAuthorized: EnsureAuthorized = async () => 'denied',
): {
  bridge: PluginMcpBridge;
  invokeRemote: InvokeRemoteCore;
} {
  if (bridge && invokeRemote) {
    return { bridge, invokeRemote };
  }

  // host 内部 tools Map 在 createMcpHost 里是 ReadonlyMap 对外暴露,
  // removeTool 已在 host 加方法直接调即可。
  const localInvoke = createInvokeRemote({
    send(owner: PluginMcpToolOwner, channel, payload): boolean {
      const wc = webContents.fromId(owner.wcId);
      if (!wc || wc.isDestroyed()) {
        // race(R32):wc 已销毁(插件窗口刚关 / reload)。返 false 让 createInvokeRemote 立即清
        // pending + reject PLUGIN_GONE,而非静默 noop 让在途 invoke 干等满 30s timeout
        // (登记 pending 与本次 send 之间 destroyed-cleanup 可能已先跑完,新 pending 无人 abort)。
        return false;
      }
      wc.send(channel, payload);
      return true;
    },
  });

  // 性能:插件激活 / 停用时逐个注册 / 注销 N 个 tool,逐次广播 list_changed 会让每个 MCP 客户端重拉
  // N 次 tools/list(每次序列化全部 schema)→ O(N²)。50ms 尾随合并为一次。
  const toolsChanged = createTrailingNotifier(() => {
    host.broadcast(TOOLS_LIST_CHANGED);
    getStdio()?.broadcast(TOOLS_LIST_CHANGED);
  }, TOOLS_LIST_CHANGED_COALESCE_MS);

  const localBridge = createPluginMcpBridge({
    host,
    invokeRemote: localInvoke,
    ensureAuthorized,
    // 安全:跨窗调用拒绝的依据 —— 注册者 wc 当前所在窗口(wc 已销毁 / 无窗口 → null,fail-closed)。
    windowIdOfWc: (wcId) => {
      const wc = webContents.fromId(wcId);
      if (!wc || wc.isDestroyed()) return null;
      return BrowserWindow.fromWebContents(wc)?.id ?? null;
    },
    notifyToolsChanged: () => toolsChanged.notify(),
  });

  bridge = localBridge;
  invokeRemote = localInvoke;

  // ── ipcMain handlers ──
  // 需要 event.sender.id 拿 wcId(register 必须知道发送方 wc 才能挂 destroyed hook)→ ctx 版外壳。

  safeHandleWithCtx(PLUGIN_MCP_CHANNELS.REGISTER, RegisterPayloadSchema, (payload, { event }) => {
    attachWcDestroyHookOnce(event.sender);
    localBridge.handleRegister(event.sender.id, payload);
  });

  safeHandleWithCtx(PLUGIN_MCP_CHANNELS.UNREGISTER, UnregisterPayloadSchema, (payload, { event }) => {
    localBridge.handleUnregister(event.sender.id, payload.name);
  });

  // INVOKE_REPLY:renderer 答 invoke,无需返回 → 用 ipcMain.on(send 配对)。
  // 与同模块 REGISTER/UNREGISTER 对齐:校验 senderFrame 可信,拒绝不受信 frame
  // (被注入的子 frame / 未来 iframe 插件隔离)伪造 reply 提前 resolve 挂起的 invoke。
  // 边界(E265,E263 main 侧对偶 / 读端独立校验):bounded/schema 校验失败时**不**把 raw reply 交 handleReply
  //(它信任 raw 的 ok/result/message/code:ok:true→resolve 超大 result、ok:false→reject 超长 message,绕过
  // InvokeReplySchema 10MB/8192/256 上限经 mcp-host 编进 JSON-RPC 放大 main)。改为仅提取 requestId(O(1) 属性
  // 读,不枚举)按固定 INVALID_REPLY 拒绝对应 pending:既收口不挂 30s,又绝不传播 raw 超大/超长字段;无可用
  // requestId 的垃圾 payload 静默丢弃(无法关联)。承第七/topic-49 session「畸形 reply 立即 reject 不挂起」语义。
  const rejectInvalidReply = (rawReply: unknown): void => {
    const rid =
      rawReply !== null &&
      typeof rawReply === 'object' &&
      !Array.isArray(rawReply)
        ? (rawReply as Record<string, unknown>)['requestId']
        : undefined;
    if (typeof rid === 'string' && rid.length > 0) {
      localInvoke.rejectPendingInvalid(rid);
    } else {
      console.warn('[plugin-mcp-invoke] invalid reply, dropped (no requestId)');
    }
  };

  ipcMain.on(PLUGIN_MCP_CHANNELS.INVOKE_REPLY, (event, raw: unknown) => {
    if (!defaultIsTrustedFrame(event.senderFrame)) return;
    // 边界(E257,E255/E256 同族 / schema-阶段放大):此 raw ipcMain.on 绕过 safeHandle 的 bounded
    // 预检,直接 InvokeReplySchema.safeParse(raw)。该 schema 是 strict discriminated union,畸形 reply
    // 带海量未知短 key 仍会先触发 Zod 枚举 + 构造 unknown-keys issue(在主进程 schema 阶段放大 CPU/内存)。
    // safeParse 前用同一 shared boundedObjectAdmissible 预检;超限不进 Zod,按 requestId 立即收口 pending。
    if (!boundedObjectAdmissible(raw).ok) {
      rejectInvalidReply(raw); // 边界(E265):不传播 raw 字段
      return;
    }
    const parsed = InvokeReplySchema.safeParse(raw);
    if (parsed.success) {
      localInvoke.handleReply(parsed.data); // 已过 schema(≤10MB/8192/256),安全交 handleReply
      return;
    }
    // 边界(E265):schema 失败的畸形 reply 不再整体交 handleReply(会信任 raw 字段传播超大 result /
    // 超长 message),改按 requestId 固定 INVALID_REPLY 收口(承 topic-49「立即 reject 不挂 30s」语义)。
    rejectInvalidReply(raw);
  });

  return { bridge: localBridge, invokeRemote: localInvoke };
}

// ── wc destroyed / reload hook ─────────────────────────────
// 审计 #4:reload 时须摘掉 main 端残留 stub,否则 Agent 仍能在 tools/list 看到旧 tool(调用 reject
// NO_SUCH_TOOL,重注册同名 throw TOOL_NAME_TAKEN)。清空后 renderer 在新文档里会重新 register,
// handleWebContentsGone 幂等安全。时机与去重见 lib/wc-gone-hook。
const attachWcDestroyHookOnce = makeWcGoneHook((wcId) => {
  bridge?.handleWebContentsGone(wcId);
});
