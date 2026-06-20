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
  ipcMain,
  webContents,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { defaultIsTrustedFrame, processIpcCall } from '../safe-handle';
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
import type { StdioSocketServer } from '../services/mcp-stdio-server.service';

/** MCP 标准 method:tool 集变更通知. */
const TOOLS_LIST_CHANGED = 'notifications/tools/list_changed';

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
  stdio?: StdioSocketServer,
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
    send(owner: PluginMcpToolOwner, channel, payload) {
      const wc = webContents.fromId(owner.wcId);
      if (!wc || wc.isDestroyed()) {
        // wc 已没,本不该走到这里(register 必跟 wc 生命周期挂钩);保险起见 noop
        return;
      }
      wc.send(channel, payload);
    },
  });

  const localBridge = createPluginMcpBridge({
    host: {
      registerTool: (t) => host.registerTool(t),
      removeTool: (name) => host.removeTool(name),
      tools: host.tools,
    },
    invokeRemote: localInvoke,
    notifyToolsChanged: () => {
      host.broadcast(TOOLS_LIST_CHANGED);
      stdio?.broadcast(TOOLS_LIST_CHANGED);
    },
  });

  bridge = localBridge;
  invokeRemote = localInvoke;

  // ── ipcMain handlers ──
  // 用手写 processIpcCall(不走 safeHandle wrapper)是因为需要 event.sender.id
  // 拿 wcId(register 必须知道发送方 wc 才能挂 destroyed hook)。

  ipcMain.handle(
    PLUGIN_MCP_CHANNELS.REGISTER,
    async (event: IpcMainInvokeEvent, raw: unknown) =>
      processIpcCall(
        RegisterPayloadSchema,
        (payload) => {
          attachWcDestroyHookOnce(event.sender);
          localBridge.handleRegister(event.sender.id, payload);
        },
        raw,
        event.senderFrame,
        defaultIsTrustedFrame,
      ),
  );

  ipcMain.handle(
    PLUGIN_MCP_CHANNELS.UNREGISTER,
    async (event: IpcMainInvokeEvent, raw: unknown) =>
      processIpcCall(
        UnregisterPayloadSchema,
        (payload) => {
          localBridge.handleUnregister(event.sender.id, payload.name);
        },
        raw,
        event.senderFrame,
        defaultIsTrustedFrame,
      ),
  );

  // INVOKE_REPLY:renderer 答 invoke,无需返回 → 用 ipcMain.on(send 配对)。
  // 与同模块 REGISTER/UNREGISTER 对齐:校验 senderFrame 可信,拒绝不受信 frame
  // (被注入的子 frame / 未来 iframe 插件隔离)伪造 reply 提前 resolve 挂起的 invoke。
  ipcMain.on(PLUGIN_MCP_CHANNELS.INVOKE_REPLY, (event, raw: unknown) => {
    if (!defaultIsTrustedFrame(event.senderFrame)) return;
    const parsed = InvokeReplySchema.safeParse(raw);
    if (parsed.success) {
      localInvoke.handleReply(parsed.data);
      return;
    }
    // schema 失败的畸形 reply 仍交给 handleReply(它对 raw 全防御):带 string requestId 但 ok
    // 畸形(缺失/非布尔)的 reply 会被立即 reject INVALID_REPLY,而非静默丢弃让对应 pending
    // invoke 干等满 30s timeout(外部 agent tools/call 看起来卡死)。完全无 requestId 的垃圾
    // payload 由 handleReply 内部静默丢弃(requestId 非 string → return)。第七 session 硬化了
    // handleReply 的 INVALID_REPLY 立即-reject,但生产入口的 schema-gate 之前把它挡在门外
    // 不可达(helper 正确但生产入口绕过 helper)。(codex 复审 loop R20-confirm)
    localInvoke.handleReply(raw);
  });

  return { bridge: localBridge, invokeRemote: localInvoke };
}

// ── wc destroyed hook(防重复 attach)─────────────────────────

const wcAttached = new WeakSet<WebContents>();

function attachWcDestroyHookOnce(wc: WebContents): void {
  if (wcAttached.has(wc)) return;
  wcAttached.add(wc);
  const wcId = wc.id;
  wc.once('destroyed', () => {
    bridge?.handleWebContentsGone(wcId);
  });
  // 审计 #4:renderer reload(Ctrl+R / HMR full reload / webContents.reload())
  // 时 webContents 不销毁、wcId 不变,但 renderer 侧 registry 被清空重建。
  // 必须在新文档加载前(did-start-navigation 早于脚本执行)摘掉 main 端残留
  // stub,否则 Agent 仍能在 tools/list 看到旧 tool(调用 reject NO_SUCH_TOOL,
  // 重注册同名 throw TOOL_NAME_TAKEN)。同 wc 持久监听,覆盖反复 reload;
  // 仅 main frame 的真实(非同文档)导航才清,避免 hash / pushState 误清。
  // 清空后 renderer 在新文档里会重新 register,handleWebContentsGone 幂等安全。
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      bridge?.handleWebContentsGone(wcId);
    }
  });
}
