import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import {
  ExplorerWritableSnapshotSchema,
  LayoutSchema,
  defaultExplorerV3,
  ensureWindowEntry,
  loadExplorer,
  mergeWritableIntoFull,
} from './persistence';
import { defaultIsTrustedFrame, safeHandle, safeHandleWithCtx } from './safe-handle';
import { atomicWriteJson } from './lib/atomic-write';
import { withExplorerFileMutex } from './lib/file-mutex';
import { getWindowSeq } from './services/window-seq.service';
import { registerFsIpc } from './ipc/fs.ipc';
import { registerTerminalIpc } from './ipc/terminal.ipc';
import { registerPluginsIpc } from './ipc/plugins.ipc';
import { registerShellIpc } from './ipc/shell.ipc';
import { registerWindowIpc } from './ipc/window.ipc';
import { registerI18nIpc } from './ipc/i18n.ipc';
import {
  registerPluginFsIpc,
  type PluginFsIpcHandles,
} from './ipc/plugin-fs.ipc';
import { registerPluginDataIpc } from './ipc/plugin-data.ipc';
import { registerPluginShellStreamIpc } from './ipc/plugin-shell-stream.ipc';
import { AGENT_AUTH_CHANNELS, AGENT_AUTH_DECISIONS } from '../shared/agent-auth-channels';
import { ERROR_CODES } from '../shared/error-codes';
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

export function registerIpc(): { pluginFsHandles: PluginFsIpcHandles } {
  const userData = app.getPath('userData');
  const explorerFile = path.join(userData, 'explorer.json');
  const trusted = defaultIsTrustedFrame;

  safeHandleWithCtx(
    'layout:read',
    NoInput,
    async (_input, { event }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        throw Object.assign(new Error('no window'), {
          code: ERROR_CODES.NO_WINDOW,
        });
      }
      const seq = getWindowSeq(win.id);
      if (seq == null) {
        throw Object.assign(new Error('no window seq'), {
          code: ERROR_CODES.NO_WINDOW_SEQ,
        });
      }
      const payload = await loadExplorer(explorerFile);
      const entry = payload?.windows.find((w) => w.windowSeq === seq);
      return entry?.layout ?? null;
    },
    trusted,
  );

  safeHandleWithCtx(
    'layout:write',
    LayoutSchema,
    async (json, { event }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        throw Object.assign(new Error('no window'), {
          code: ERROR_CODES.NO_WINDOW,
        });
      }
      const seq = getWindowSeq(win.id);
      if (seq == null) {
        throw Object.assign(new Error('no window seq'), {
          code: ERROR_CODES.NO_WINDOW_SEQ,
        });
      }

      await withExplorerFileMutex(async () => {
        const payload =
          (await loadExplorer(explorerFile)) ?? defaultExplorerV3();
        const entry = ensureWindowEntry(payload, seq);
        entry.layout = LayoutSchema.parse(json);
        await atomicWriteJson(explorerFile, payload);
      });
    },
    trusted,
  );

  // 资源管理器持久化(Step 3 / ADR-012)
  safeHandle(
    'explorer:read',
    NoInput,
    () => loadExplorer(explorerFile),
    trusted,
  );
  safeHandleWithCtx(
    'explorer:write',
    ExplorerWritableSnapshotSchema,
    async (writable, { event }) => {
      // 持久化边界收口:一个窗口只能写自己 windowSeq 的段(同 layout:read/write 早用
      // 的 ctx + getWindowSeq 模式,explorer:write 之前漏了)。renderer 的
      // snapshotFromStores 正常只发自己段,但若陈旧闭包/回归路径夹带别窗 entry,
      // mergeWritableIntoFull 会把别窗段一并写回 → 单窗陈旧写覆盖别窗 root/tabs/
      // 展开态(R7 曾是真 bug)。按 sender 的真实 seq 过滤 foreign 段,丢弃非自己的窗口
      // entry,既保留自己段的写入又杜绝跨窗 clobber。(codex 复审 loop R11)
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        throw Object.assign(new Error('no window'), {
          code: ERROR_CODES.NO_WINDOW,
        });
      }
      const seq = getWindowSeq(win.id);
      if (seq == null) {
        throw Object.assign(new Error('no window seq'), {
          code: ERROR_CODES.NO_WINDOW_SEQ,
        });
      }
      const ownOnly = {
        ...writable,
        windows: writable.windows.filter((w) => w.windowSeq === seq),
      };
      await withExplorerFileMutex(async () => {
        const current = await loadExplorer(explorerFile);
        const merged = mergeWritableIntoFull(current, ownOnly);
        await atomicWriteJson(explorerFile, merged);
      });
    },
    trusted,
  );

  // M5 真做 popout 时实现;占位时统一抛业务码,renderer 拿到 IpcFail 即可。
  safeHandle(
    'popout:open',
    PopoutOpenInput,
    () => {
      throw Object.assign(new Error('popout:open not implemented yet (M5)'), {
        code: ERROR_CODES.POPOUT_NOT_IMPLEMENTED,
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

  // plugin app.fs path-scoped backend(topic 01)
  const pluginFsHandles = registerPluginFsIpc({ ipcMain });

  // plugin app.dataStore IPC-backed persistence(topic 01)
  registerPluginDataIpc({ ipcMain });

  // plugin app.shell.execStream backend(topic 01)
  registerPluginShellStreamIpc({ ipcMain });

  // 多窗口支持(issue #23 Phase 1):window.create
  registerWindowIpc();

  // Agent Terminal MCP — 授权应答通道(P2)
  const agentAuthRespondSchema = z
    .object({
      requestId: z.string().min(1),
      decision: z.enum(AGENT_AUTH_DECISIONS),
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

  registerI18nIpc(trusted);

  return { pluginFsHandles };
}
