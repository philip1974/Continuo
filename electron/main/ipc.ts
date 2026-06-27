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
  type ExplorerPayloadV3,
  type ExplorerWritablePayload,
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
import { registerMarketplaceIpc } from './ipc/marketplace.ipc';
import {
  registerPluginFsIpc,
  type PluginFsIpcHandles,
} from './ipc/plugin-fs.ipc';
import { registerPluginDataIpc } from './ipc/plugin-data.ipc';
import { registerPluginShellStreamIpc } from './ipc/plugin-shell-stream.ipc';
import { AGENT_AUTH_CHANNELS } from '../shared/agent-auth-channels';
import { ERROR_CODES } from '../shared/error-codes';
import { assertJsonValue } from '../shared/assert-json-value';
import { AgentAuthRespondSchema } from './agent-auth-schema';
import { PopoutOpenInput } from './popout-open-schema';
import { utf8ByteLength } from '../shared/utf8-byte-length';
import { jsonByteLowerBoundExceeds } from '../shared/json-byte-budget';
import { findWindowEntryBySeq } from '../shared/window-entry-lookup';
import {
  resolveAgentAuthRequest,
  revokeAndKillAgentSessions,
} from './services/agent-auth.service';
import { MCP_CHANNELS } from '../shared/mcp-channels';
import { getStdioConfig } from './services/mcp-stdio-config.service';

// layout:read 入参为空(renderer ipcRenderer.invoke 不传第二参 → undefined)
const NoInput = z.undefined();

export function filterWritableSnapshotForWindowSeq(
  writable: ExplorerWritablePayload,
  seq: number,
): ExplorerWritablePayload {
  let ownWindows: ExplorerWritablePayload['windows'] | null = null;
  let ownWindowCount = 0;

  for (let i = 0; i < writable.windows.length; i++) {
    const w = writable.windows[i]!;
    if (w.windowSeq !== seq) {
      if (ownWindows === null) {
        ownWindows = new Array<ExplorerWritablePayload['windows'][number]>(
          writable.windows.length - 1,
        );
        for (let j = 0; j < i; j++) {
          ownWindows[ownWindowCount++] = writable.windows[j]!;
        }
      }
      continue;
    }
    if (ownWindows !== null) ownWindows[ownWindowCount++] = w;
  }

  if (ownWindows !== null) ownWindows.length = ownWindowCount;
  return ownWindows === null ? writable : { ...writable, windows: ownWindows };
}

export function sanitizeExplorerReadPayload(
  payload: ExplorerPayloadV3,
): ExplorerPayloadV3 {
  let windows: ExplorerPayloadV3['windows'] | null = null;
  let windowCount = 0;

  for (let i = 0; i < payload.windows.length; i++) {
    const w = payload.windows[i]!;
    if (w.layout == null || sanitizeReadLayout(w.layout) !== null) {
      if (windows !== null) windows[windowCount++] = w;
      continue;
    }

    if (windows === null) {
      windows = new Array<ExplorerPayloadV3['windows'][number]>(
        payload.windows.length,
      );
      for (let j = 0; j < i; j++) {
        windows[windowCount++] = payload.windows[j]!;
      }
    }
    const rest = { ...w };
    delete rest.layout; // 超大/非 JSON-safe layout → 剥离
    windows[windowCount++] = rest;
  }

  if (windows !== null) windows.length = windowCount;
  return windows === null ? payload : { ...payload, windows };
}

// 边界(E89/E215):单窗口 dockview layout 序列化字节上限 + 读端守卫,收口到 lib/layout-read-guard
//(写端 layout:write 与读端 layout:read 共用;ipc.ts 顶层 app 副作用不可测试导入,故抽出可导入模块)。
import {
  MAX_LAYOUT_BYTES,
  sanitizeReadLayout,
} from './lib/layout-read-guard';

// popout:open 入参 schema 见 ./popout-open-schema(单列以便测试 import,E316;
// panelId ≤256 + .strict(),与 AgentAuthRespondSchema 同型)。
// Agent Terminal MCP 授权应答 schema 见 ./agent-auth-schema(单列以便测试 import,E146)。

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
      const entry =
        payload === null ? null : findWindowEntryBySeq(payload.windows, seq);
      // 边界(E215,E89 写端对偶):读端复用写端 JSON-safe + 字节上限,旧版/污染的超大 layout → null
      //(走默认布局),不让 renderer fromJSON 处理超大 layout 卡顿/放大。
      return sanitizeReadLayout(entry?.layout ?? null);
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

      const layout = LayoutSchema.parse(json);
      // 边界(E89,E67 对偶):LayoutSchema 是 .passthrough() 无序列化大小上限。畸形 renderer/
      // dockview 状态可写入超大 layout → explorer.json 撑爆 → 下次 loadExplorer 命中 16MiB
      // 上限(E67)拒读 → 布局/窗口/会话恢复整体失效 + 写路径 fail-closed 卡死。写盘前按序列化
      // 字节上限校验(远小于 explorer 16MiB,确保整文件仍可读),超限拒写并保留旧 layout。
      // 边界(E308,E305-E307 reorder 同族 / 校验顺序 fail-fast):字节下界 fail-fast 在 assertJsonValue
      // 全量遍历之前 —— 超 2MiB 但 shape 合法(≤assertJsonValue 1M/10万/256 上限)的 layout 不被 assertJsonValue
      // 完整遍历后才拒。jsonByteLowerBoundExceeds 对任意输入安全(E288)可先跑。(仅「既非 JSON-safe 又超限」
      // 病态 layout 错误码从 BAD_INPUT 变 PAYLOAD_TOO_LARGE —— 两者皆拒写,单-bad 不变。)
      if (jsonByteLowerBoundExceeds(layout, MAX_LAYOUT_BYTES)) {
        throw Object.assign(
          new Error(`layout too large (> ${MAX_LAYOUT_BYTES})`),
          { code: ERROR_CODES.PAYLOAD_TOO_LARGE },
        );
      }
      // 边界(E119,E105/E117 同族):LayoutSchema 是 .passthrough(),layout 可含 Infinity/NaN/
      // undefined(structured-clone 经 IPC 保留)。仅 JSON.stringify 判大小会静默把这些改成 null/
      // 丢字段 → 写盘后 dock layout/面板 params 与内存态不一致。assertJsonValue 拒非 JSON 安全值。
      try {
        assertJsonValue(layout);
      } catch {
        throw Object.assign(
          new Error('layout contains non-JSON-safe values'),
          { code: ERROR_CODES.BAD_INPUT },
        );
      }
      const serialized = JSON.stringify(layout);
      // 边界(E125):真实 UTF-8 字节(非 .length=UTF-16 code unit),防多字节 layout 绕过上限撑爆 explorer.json。
      const layoutBytes = utf8ByteLength(serialized);
      if (layoutBytes > MAX_LAYOUT_BYTES) {
        throw Object.assign(
          new Error(`layout too large (${layoutBytes} > ${MAX_LAYOUT_BYTES})`),
          { code: ERROR_CODES.PAYLOAD_TOO_LARGE },
        );
      }

      await withExplorerFileMutex(async () => {
        const payload =
          (await loadExplorer(explorerFile)) ?? defaultExplorerV3();
        const entry = ensureWindowEntry(payload, seq);
        if (
          entry.layout !== undefined &&
          JSON.stringify(entry.layout) === serialized
        ) {
          return;
        }
        entry.layout = layout;
        await atomicWriteJson(explorerFile, payload);
      });
    },
    trusted,
  );

  // 资源管理器持久化(Step 3 / ADR-012)
  safeHandle(
    'explorer:read',
    NoInput,
    async () => {
      const payload = await loadExplorer(explorerFile);
      if (!payload) return payload; // null(首次启动 / 损坏保留)
      // 边界(E261,E215 同入口对偶 / 读端 cap 绕过):explorer:read 返回完整 payload(含 windows[].layout)。
      // layout 的 2MiB 读端 cap(sanitizeReadLayout,E215)此前只用于 layout:read —— 污染/旧版 explorer.json
      // 可携带接近 16MiB 文件上限的超大 layout 经 LayoutSchema.passthrough() 绕过 layout 读 cap,使 renderer
      // 启动 hydrate 无谓 structured-clone/传输巨大 layout 卡顿/内存峰值。返回前对每个 window.layout 复用
      // 同一读端守卫:超限/非 JSON-safe → 剥离该 layout(renderer 走默认布局),合法则原样保留。
      return sanitizeExplorerReadPayload(payload);
    },
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
      const ownOnly = filterWritableSnapshotForWindowSeq(writable, seq);
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

  // 安全 S4:marketplace reviews 拉取(token 在 main,不内联进 renderer)
  registerMarketplaceIpc();

  // plugin app.fs path-scoped backend(topic 01)
  const pluginFsHandles = registerPluginFsIpc({ ipcMain });

  // plugin app.dataStore IPC-backed persistence(topic 01)
  registerPluginDataIpc({ ipcMain });

  // plugin app.shell.execStream backend(topic 01)
  registerPluginShellStreamIpc({ ipcMain });

  // 多窗口支持(issue #23 Phase 1):window.create
  registerWindowIpc();

  // Agent Terminal MCP — 授权应答通道(P2)。schema 见模块级 AgentAuthRespondSchema(E146)。
  safeHandle(
    AGENT_AUTH_CHANNELS.RESPOND,
    AgentAuthRespondSchema,
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
