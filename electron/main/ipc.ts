import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { EXPLORER_CHANNELS, LAYOUT_CHANNELS } from '../shared/persistence-channels';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  ExplorerWritableSnapshotSchema,
  LayoutSchema,
  defaultExplorerV3,
  ensureWindowEntry,
  loadExplorer,
  mergeWritableIntoFull,
  promoteRecentRoot,
  removeRecentRoot,
  type ExplorerPayloadV3,
  type ExplorerWritablePayload,
  writeExplorerFile,
} from './persistence';
import {
  EXPLORER_FILE_NAME,
  MAIN_OWNED_WINDOW_FIELDS,
  PATH_STR_MAX,
  WorkspaceSwitchInputSchema,
} from '../shared/explorer-persistence-schema';
import { switchWorkspaceSnapshot } from './services/workspace-snapshot.service';
import { isBlankString } from '../shared/ecma-whitespace';
import { broadcastToWindows } from './lib/broadcast';
import { safeHandle, safeHandleWithCtx, withTrustedFrameGate } from './safe-handle';
import { withExplorerFileMutex } from './lib/file-mutex';
import { getWindowSeq } from './services/window-seq.service';
import { registerFsIpc } from './ipc/fs.ipc';
import { registerSearchIpc } from './ipc/search.ipc';
import { registerGitIpc } from './ipc/git.ipc';
import { registerTerminalIpc } from './ipc/terminal.ipc';
import { registerPluginsIpc } from './ipc/plugins.ipc';
import { registerShellIpc } from './ipc/shell.ipc';
import { registerWindowIpc, type WindowIpcDeps } from './ipc/window.ipc';
import { registerI18nIpc } from './ipc/i18n.ipc';
import { registerMarketplaceIpc } from './ipc/marketplace.ipc';
import { registerPluginFsIpc } from './ipc/plugin-fs.ipc';
import { registerPluginDataIpc } from './ipc/plugin-data.ipc';
import { registerPluginShellStreamHandlers } from './services/plugin-shell-stream.service';
import { AGENT_AUTH_CHANNELS } from '../shared/agent-auth-channels';
import { ERROR_CODES } from '../shared/error-codes';
import { assertJsonValue } from '../shared/assert-json-value';
import { AgentAuthRespondSchema } from './agent-auth-schema';
import { utf8ByteLength } from '../shared/utf8-byte-length';
import { jsonStringLengthLowerBoundExceeds } from '../shared/json-byte-budget';
import { findWindowEntryBySeq } from '../shared/window-entry-lookup';
import {
  answerAgentAuthRequest,
  countAgentTerminalSessions,
  revokeAndKillAgentSessions,
} from './services/agent-auth.service';
import { MCP_CHANNELS } from '../shared/mcp-channels';
import { getStdioConfig } from './services/mcp-stdio-config.service';
import { codedError } from '../shared/error-message';

// layout:read 入参为空(renderer ipcRenderer.invoke 不传第二参 → undefined)
const NoInput = z.undefined();
// touch-recent / remove-recent 共用入参
const TouchRecentInput = z
  .object({ path: z.string().max(PATH_STR_MAX).refine((p) => !isBlankString(p)) })
  .strict();

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

/**
 * explorer:read 返回前剥离窗口段里 main 独占的字段(MAIN_OWNED_WINDOW_FIELDS:layout / lastClosedAt)。
 * renderer 不读它们(layout 只经 layout:read 到达,带读端 cap);不剥离则每次冷启动把所有窗口的 layout
 * structured-clone 给 renderer 再过一遍 zod。没有窗口携带这些字段时原样返回。
 */
export function stripMainOwnedWindowFields(payload: ExplorerPayloadV3): ExplorerPayloadV3 {
  const owns = (w: ExplorerPayloadV3['windows'][number]): boolean =>
    MAIN_OWNED_WINDOW_FIELDS.some((field) => w[field] !== undefined);
  // 按文件夹的会话快照(含 dock 布局)同样只属 main:renderer 经 explorer:switch-workspace / 新窗口建段拿到需要的那一份。
  if (payload.workspaceSnapshots !== undefined) {
    const { workspaceSnapshots: _snapshots, ...rest } = payload;
    return stripMainOwnedWindowFields(rest);
  }
  if (!payload.windows.some(owns)) return payload;
  return {
    ...payload,
    windows: payload.windows.map((w) => {
      if (!owns(w)) return w;
      const rest = { ...w };
      for (const field of MAIN_OWNED_WINDOW_FIELDS) delete rest[field];
      return rest;
    }),
  };
}

// 边界(E89/E215):单窗口 dockview layout 序列化字节上限 + 读端守卫,收口到 lib/layout-read-guard
//(写端 layout:write 与读端 layout:read 共用,抽成独立模块便于单测)。
import {
  MAX_LAYOUT_BYTES,
  sanitizeReadLayout,
} from './lib/layout-read-guard';
import { countPopoutGroups, notePopoutRestore } from './services/popout-restore-focus.service';

// Agent Terminal MCP 授权应答 schema 见 ./agent-auth-schema(单列以便测试 import,E146)。

/**
 * 解析 IPC sender 所在窗口的 windowSeq(explorer.json 里窗口段的稳定键)。持久化边界:一个窗口只能
 * 读写自己 windowSeq 的段 —— layout:read / layout:write / explorer:write 共用(explorer:write 曾漏接,
 * 导致单窗陈旧写覆盖别窗段,R7 / 复审 R11)。
 */
function senderWindowSeqOrThrow(event: IpcMainInvokeEvent): number {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    throw codedError(ERROR_CODES.NO_WINDOW, 'no window');
  }
  const seq = getWindowSeq(win.id);
  if (seq == null) {
    throw codedError(ERROR_CODES.NO_WINDOW_SEQ, 'no window seq');
  }
  return seq;
}

export function registerIpc(deps: WindowIpcDeps): void {
  const userData = app.getPath('userData');
  const explorerFile = path.join(userData, EXPLORER_FILE_NAME);

  safeHandleWithCtx(
    LAYOUT_CHANNELS.READ,
    NoInput,
    async (_input, { event }) => {
      const seq = senderWindowSeqOrThrow(event);
      const payload = await loadExplorer(explorerFile);
      const entry =
        payload === null ? null : findWindowEntryBySeq(payload.windows, seq);
      // 边界(E215,E89 写端对偶):读端复用写端 JSON-safe + 字节上限,旧版/污染的超大 layout → null
      //(走默认布局),不让 renderer fromJSON 处理超大 layout 卡顿/放大。
      const layout = sanitizeReadLayout(entry?.layout ?? null);
      // 恢复的 popout 子窗不抢主窗焦点:登记该窗口接下来将恢复的 popout 数(见 popout-restore-focus.service)。
      const senderId = (event.sender as { id?: unknown }).id;
      if (typeof senderId === 'number') notePopoutRestore(senderId, countPopoutGroups(layout));
      return layout;
    },
  );

  safeHandleWithCtx(
    LAYOUT_CHANNELS.WRITE,
    LayoutSchema,
    async (json, { event }) => {
      const seq = senderWindowSeqOrThrow(event);

      // json 已由 safeHandleWithCtx 用 LayoutSchema 解析过,这里不再二次 parse(passthrough 对象会被
      // 再拷贝一遍,且发生在下方字节上限检查之前)。
      const layout = json;
      // 边界(E89,E67 对偶):LayoutSchema 是 .passthrough() 无序列化大小上限。畸形 renderer/
      // dockview 状态可写入超大 layout → explorer.json 撑爆 → 下次 loadExplorer 命中 16MiB
      // 上限(E67)拒读 → 布局/窗口/会话恢复整体失效 + 写路径 fail-closed 卡死。写盘前按序列化
      // 字节上限校验,超限拒写并保留旧 layout(整个文件 ≤16MiB 由写入口 writeExplorerFile 按总量保证)。
      // 边界(E308,E305-E307 reorder 同族 / 校验顺序 fail-fast):字节下界 fail-fast 在 assertJsonValue
      // 全量遍历之前 —— 超 2MiB 但 shape 合法(≤assertJsonValue 1M/10万/256 上限)的 layout 不被 assertJsonValue
      // 完整遍历后才拒。jsonByteLowerBoundExceeds 对任意输入安全(E288)可先跑。(仅「既非 JSON-safe 又超限」
      // 病态 layout 错误码从 BAD_INPUT 变 PAYLOAD_TOO_LARGE —— 两者皆拒写,单-bad 不变。)
      // perf:预检用 .length 下界(每串 O(1),不逐字符计 UTF-8):其后有 stringify + 精确 UTF-8 字节终裁,
      // .length ≤ UTF-8 字节仍是合法下界,判定不变(多字节超限只是从预检挪到精确终裁拒)。
      if (jsonStringLengthLowerBoundExceeds(layout, MAX_LAYOUT_BYTES)) {
        throw codedError(ERROR_CODES.PAYLOAD_TOO_LARGE, `layout too large (> ${MAX_LAYOUT_BYTES})`);
      }
      // 边界(E119,E105/E117 同族):LayoutSchema 是 .passthrough(),layout 可含 Infinity/NaN/
      // undefined(structured-clone 经 IPC 保留)。仅 JSON.stringify 判大小会静默把这些改成 null/
      // 丢字段 → 写盘后 dock layout/面板 params 与内存态不一致。assertJsonValue 拒非 JSON 安全值。
      try {
        assertJsonValue(layout);
      } catch {
        throw codedError(ERROR_CODES.BAD_INPUT, 'layout contains non-JSON-safe values');
      }
      const serialized = JSON.stringify(layout);
      // 边界(E125):真实 UTF-8 字节(非 .length=UTF-16 code unit),防多字节 layout 绕过上限撑爆 explorer.json。
      const layoutBytes = utf8ByteLength(serialized);
      if (layoutBytes > MAX_LAYOUT_BYTES) {
        throw codedError(ERROR_CODES.PAYLOAD_TOO_LARGE, `layout too large (${layoutBytes} > ${MAX_LAYOUT_BYTES})`);
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
        await writeExplorerFile(explorerFile, payload);
      });
    },
  );

  // 资源管理器持久化(Step 3 / ADR-012)
  safeHandle(
    EXPLORER_CHANNELS.READ,
    NoInput,
    async () => {
      const payload = await loadExplorer(explorerFile);
      if (!payload) return payload; // null(首次启动 / 损坏保留)
      return stripMainOwnedWindowFields(payload);
    },
  );
  safeHandleWithCtx(
    EXPLORER_CHANNELS.WRITE,
    ExplorerWritableSnapshotSchema,
    async (writable, { event }) => {
      // 持久化边界收口:一个窗口只能写自己 windowSeq 的段(同 layout:read/write 早用
      // 的 ctx + getWindowSeq 模式,explorer:write 之前漏了)。renderer 的
      // snapshotFromStores 正常只发自己段,但若陈旧闭包/回归路径夹带别窗 entry,
      // mergeWritableIntoFull 会把别窗段一并写回 → 单窗陈旧写覆盖别窗 root/tabs/
      // 展开态(R7 曾是真 bug)。按 sender 的真实 seq 过滤 foreign 段,丢弃非自己的窗口
      // entry,既保留自己段的写入又杜绝跨窗 clobber。(复审 loop R11)
      const seq = senderWindowSeqOrThrow(event);
      const ownOnly = filterWritableSnapshotForWindowSeq(writable, seq);
      await withExplorerFileMutex(async () => {
        const current = await loadExplorer(explorerFile);
        const merged = mergeWritableIntoFull(current, ownOnly);
        if (current !== null && isDeepStrictEqual(merged, current)) return;
        await writeExplorerFile(explorerFile, merged);
      });
    },
  );

  // 同一窗口切换 root(⌘O / 最近打开 / 拖入文件夹 / 关闭文件夹):存旧 root 的快照、返回新 root 的快照。按 sender 的真实
  // seq 取本窗段的 dock 布局(同 explorer:write 的持久化边界)。BDD: src/__tests__/workspace-snapshot/
  safeHandleWithCtx(EXPLORER_CHANNELS.SWITCH_WORKSPACE, WorkspaceSwitchInputSchema, async (input, { event }) =>
    switchWorkspaceSnapshot(explorerFile, senderWindowSeqOrThrow(event), input),
  );

  // 全局「最近打开」增量变更(多窗口:explorer:write 不再整表覆盖 recentRoots,见 mergeWritableIntoFull)。
  // 锁内重读盘 → 变更 → 写盘 → 锁内广播(多次变更的广播与写盘同序)。盘上尚无文件(首启)不写不广播:
  // 该窗口随后的 explorer:write 以 writable 值创建文件。
  const mutateRecentRoots = (
    channel: string,
    change: (list: readonly string[], path: string) => string[],
  ): void => {
    safeHandle(channel, TouchRecentInput, async ({ path: root }) => {
      await withExplorerFileMutex(async () => {
        const current = await loadExplorer(explorerFile);
        if (!current) return;
        const recentRoots = change(current.workspace.recentRoots, root);
        if (!isDeepStrictEqual(recentRoots, current.workspace.recentRoots)) {
          await writeExplorerFile(explorerFile, { ...current, workspace: { ...current.workspace, recentRoots } });
        }
        broadcastToWindows(
          EXPLORER_CHANNELS.RECENT_CHANGED,
          () => ({ recentRoots }),
          '[explorer] RECENT_CHANGED',
        );
      });
    });
  };
  mutateRecentRoots(EXPLORER_CHANNELS.TOUCH_RECENT, (list, p) => promoteRecentRoot(list, p));
  // VSCode「从最近打开列表中删除」:最近项上的 × / Delete、或打开时发现目录已不存在后确认移除。
  mutateRecentRoots(EXPLORER_CHANNELS.REMOVE_RECENT, (list, p) => removeRecentRoot(list, p));

  // 资源管理器 fs.*(Step 2)
  registerFsIpc();

  // 在文件中查找 search.*(workspace-search)
  registerSearchIpc();

  // 资源管理器 git 状态装饰 git.*
  registerGitIpc();

  // 终端 terminal.*(Step T2)
  registerTerminalIpc();

  // 插件系统 plugins.*(M-Plugin v4.1)
  registerPluginsIpc();

  // plugin app.shell.exec 后端(v5 Phase 4+)
  registerShellIpc();

  // 安全 S4:marketplace reviews 拉取(token 在 main,不内联进 renderer)
  registerMarketplaceIpc();

  // plugin app.fs path-scoped backend(topic 01)
  registerPluginFsIpc({ ipcMain });

  // plugin app.dataStore IPC-backed persistence(topic 01)
  registerPluginDataIpc();

  // plugin app.shell.execStream backend(topic 01)。注册点统一加 frame-trust 门(同 plugin-fs / plugin-data):
  // START 直接 spawn,service 内新增 channel 也不会漏门。
  registerPluginShellStreamHandlers(withTrustedFrameGate(ipcMain));

  // 多窗口支持(issue #23 Phase 1):window.create
  registerWindowIpc(deps);

  // Agent Terminal MCP — 授权应答通道(P2)。schema 见模块级 AgentAuthRespondSchema(E146)。
  safeHandleWithCtx(
    AGENT_AUTH_CHANNELS.RESPOND,
    AgentAuthRespondSchema,
    // 已不在等待的 requestId(撤销 / 超时已结算)→ 抛错返回 ok:false,renderer 据此不记 session 授权。
    // 安全:只接受请求目标窗口的应答(sender 所在窗口由 main 推断,不信 renderer 自报)。
    ({ requestId, decision }, { event }) => {
      const senderWindowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
      answerAgentAuthRequest(requestId, decision, senderWindowId);
    },
  );

  // 撤销 session 授权 + 终止全部 agent terminal(状态栏按钮触发)。
  // 入参空对象,返回 { killed, rotated } 给 renderer 显示 toast / 反馈。
  const agentAuthRevokeSchema = z.object({}).strict();
  safeHandle(
    AGENT_AUTH_CHANNELS.REVOKE,
    agentAuthRevokeSchema,
    () => revokeAndKillAgentSessions(),
  );

  // 撤销确认框的数量:撤销终止的是**所有窗口**的 agent terminal,renderer 只知道本窗口的,故由 main 给全局数。
  safeHandle(
    AGENT_AUTH_CHANNELS.COUNT_AGENT_TERMINALS,
    z.object({}).strict(),
    () => ({ count: countAgentTerminalSessions() }),
  );

  // 状态栏"复制 MCP 配置"按钮:返回当前 stdio config(命令字符串可直接 copy 跑)
  const mcpGetConfigSchema = z.object({}).strict();
  safeHandle(
    MCP_CHANNELS.GET_STDIO_CONFIG,
    mcpGetConfigSchema,
    () => getStdioConfig(),
  );

  registerI18nIpc();
}
