import { app } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import {
  ExplorerSchema,
  LayoutSchema,
  loadExplorer,
  loadLayout,
  saveExplorer,
  saveLayout,
} from './persistence';
import { defaultIsTrustedFrame, safeHandle } from './safe-handle';
import { registerFsIpc } from './ipc/fs.ipc';
import { registerTerminalIpc } from './ipc/terminal.ipc';
import { registerPluginsIpc } from './ipc/plugins.ipc';
import { registerShellIpc } from './ipc/shell.ipc';
import { AGENT_AUTH_CHANNELS } from '../shared/agent-auth-channels';
import {
  resolveAgentAuthRequest,
  revokeAndKillAgentSessions,
} from './services/agent-auth.service';
import { MCP_CHANNELS } from '../shared/mcp-channels';
import { getStdioConfig } from './services/mcp-stdio-config.service';

// layout:read 入参为空(renderer ipcRenderer.invoke 不传第二参 → undefined)
const NoInput = z.undefined();

// popout:open 入参占位 schema,M5 真实现时再扩展 bounds 等字段
const PopoutOpenInput = z
  .object({ panelId: z.string().min(1) })
  .passthrough();

export function registerIpc() {
  const userData = app.getPath('userData');
  const layoutFile = path.join(userData, 'layout.json');
  const explorerFile = path.join(userData, 'explorer.json');
  const trusted = defaultIsTrustedFrame;

  safeHandle('layout:read', NoInput, () => loadLayout(layoutFile), trusted);

  safeHandle(
    'layout:write',
    LayoutSchema,
    async (json) => {
      // saveLayout 内部还会 LayoutSchema.parse 一次,双重保险,可接受
      await saveLayout(layoutFile, json);
    },
    trusted,
  );

  // 资源管理器持久化(Step 3 / ADR-012)
  safeHandle('explorer:read', NoInput, () => loadExplorer(explorerFile), trusted);
  safeHandle(
    'explorer:write',
    ExplorerSchema,
    async (json) => {
      await saveExplorer(explorerFile, json);
    },
    trusted,
  );

  // M5 真做 popout 时实现;占位时统一抛业务码,renderer 拿到 IpcFail 即可。
  safeHandle(
    'popout:open',
    PopoutOpenInput,
    () => {
      throw Object.assign(new Error('popout:open not implemented yet (M5)'), {
        code: 'POPOUT_NOT_IMPLEMENTED',
      });
    },
    trusted,
  );

  // 资源管理器 fs.* 9 通道(Step 2)
  registerFsIpc();

  // 终端 terminal.* 6 invoke + 4 push(Step T2)
  registerTerminalIpc();

  // 插件系统 plugins.* 3 通道(M-Plugin v4.1)
  registerPluginsIpc();

  // plugin app.shell.exec 后端(v5 Phase 4+)
  registerShellIpc();

  // Agent Terminal MCP — 授权应答通道(P2)
  const agentAuthRespondSchema = z
    .object({
      requestId: z.string().min(1),
      decision: z.enum(['once', 'session', 'denied']),
    })
    .strict();
  safeHandle(
    AGENT_AUTH_CHANNELS.RESPOND,
    agentAuthRespondSchema,
    ({ requestId, decision }) => {
      resolveAgentAuthRequest(requestId, decision);
    },
    trusted,
  );

  // 撤销 session 授权 + 终止全部 agent terminal(状态栏按钮触发)。
  // 入参空对象,返回 { killed, rotated } 给 renderer 显示 toast / 反馈。
  const agentAuthRevokeSchema = z.object({}).strict();
  safeHandle(
    AGENT_AUTH_CHANNELS.REVOKE,
    agentAuthRevokeSchema,
    () => revokeAndKillAgentSessions(),
    trusted,
  );

  // 状态栏"复制 MCP 配置"按钮:返回当前 stdio config(命令字符串可直接 copy 跑)
  const mcpGetConfigSchema = z.object({}).strict();
  safeHandle(
    MCP_CHANNELS.GET_STDIO_CONFIG,
    mcpGetConfigSchema,
    () => getStdioConfig(),
    trusted,
  );
}
