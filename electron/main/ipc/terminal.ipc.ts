// Terminal IPC 接入(M-Terminal Step T2 + Agent Terminal MCP P1)。
// 8 invoke 通道 + 5 push event 通道。schemas / handlers 单独 export 给 spec 测;
// registerTerminalIpc() 真注册 + 订阅 sessions_changed 广播给所有 BrowserWindow。

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { z } from 'zod';
import { defaultIsTrustedFrame, processIpcCall } from '../safe-handle';
import { TERMINAL_CHANNELS } from '../../shared/terminal-channels';
import { getDefaultShell, isAllowedShell } from '@continuo-terminal/server-node';
import { shellFamilyForPath } from '../services/shell-args';
import { ERROR_CODES } from '../../shared/error-codes';
import { TERMINAL_ATTACH_REJECT_REASONS } from '../../shared/terminal-attach';
import {
  TerminalCreateInputSchema,
  PATH_MAX,
  type TerminalCreateInput,
} from '../../shared/terminal-create';
import * as termService from '../services/terminal.service';
import * as terminalSessions from '../services/terminal-sessions.service';
import { mcpRevokers } from '../services/mcp-host.service';
import { getWorkspaceRoot as getWindowWorkspaceRoot } from '../services/window-workspace-roots.service';
// 边界(E33,E11/E23 同族):session id 此前各 schema 只 .min(1) 无上限。id 进会话表查找 + 错误消息
// 拼接 + sessions_changed 广播,畸形超长 id/cwd 会让主进程会话表/快照/Dock 渲染携带巨大字符串。
// id 是 `term-<uuid>` 形态,256 远超真实;cwd 复用 create 的 PATH_MAX。
// E203:常量收口到 shared/session-id-limits(此前 terminal.store.ts / 本文件 / MCP tools 各副本,防漂移)。
import { SESSION_ID_MAX } from '../../shared/session-id-limits';
// 边界(E219,E125/E127/E129 字节 vs code-unit 族):terminal:write data 须按真实 UTF-8 字节限,
// 非 .max()(UTF-16 code unit)—— CJK/emoji 在 length≤上限时真实字节数倍超,实际写 6-8MB 到 PTY/IPC。
import { utf8BytesExceed } from '../../shared/utf8-byte-length';

// ── 常量 ─────────────────────────────────────────────────────
const MAX_WRITE_BYTES = 2_000_000; // ~2MB 真实 UTF-8 字节上限(下游 PTY/IPC 写入按字节,边界语义统一)
const UPDATE_CWD_CHANNEL = 'session:update-cwd';

// ── MCP env provider(由 main/index.ts 在 mcp host 启动后注入)──
// 默认空 → 不注入 MCP 信息;启动 host 后调 setMcpEnvProvider 注册真函数。
export interface McpEnvBundle {
  readonly env: Record<string, string>;
  readonly mcpToken: string;
}

let mcpEnvProvider: (windowId: number) => McpEnvBundle = () => ({
  env: {},
  mcpToken: '',
});

export function setMcpEnvProvider(
  fn: (windowId: number) => McpEnvBundle,
): void {
  mcpEnvProvider = fn;
}

// stop-hook 等待者取消器(由 main/index.ts 在 broker 启动后注入)。默认 no-op,
// 这样 broker 未启动 / 未 wire 时窗口关闭清理仍正常工作(审计 #3)。
let stopHookCanceller: (windowId: number) => void = () => {};

export function setStopHookCanceller(
  fn: (windowId: number) => void,
): void {
  stopHookCanceller = fn;
}

// ── schemas(.strict() 拒未知字段) ────────────────────────────

// 可维护性 M24:create 入参 schema/类型抽到 shared/terminal-create(main+preload 单一来源)。
export const createInputSchema = TerminalCreateInputSchema;

export const writeInputSchema = z
  .object({
    id: z.string().min(1).max(SESSION_ID_MAX),
    // 边界(E219,E129 同款):按真实 UTF-8 字节限,非 .max()(UTF-16 code unit)。CJK/emoji 多字节
    // 输入否则 length≤上限但真实字节数倍超,实际写 6-8MB 到 PTY/IPC,与下游字节 cap 边界语义不一致。
    data: z
      .string()
      .refine((s) => !utf8BytesExceed(s, MAX_WRITE_BYTES), {
        message: `data 超过上限 ${MAX_WRITE_BYTES} 字节`,
      }),
  })
  .strict();

export const resizeInputSchema = z
  .object({
    id: z.string().min(1).max(SESSION_ID_MAX),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(500),
  })
  .strict();

// 边界(E33):cwd .max(PATH_MAX);id .max(SESSION_ID_MAX)。updateCwd 把 cwd 写进 session
// metadata 并触发 sessions_changed 广播,超长值会让每次快照广播 + Dock 渲染携带巨大字符串。
export const updateCwdInputSchema = z
  .object({
    id: z.string().min(1).max(SESSION_ID_MAX),
    cwd: z.string().min(1).max(PATH_MAX),
  })
  .strict();

export const idOnlyInputSchema = z
  .object({ id: z.string().min(1).max(SESSION_ID_MAX) })
  .strict();

export const noInputSchema = z.object({}).strict();

// topic-05: renderer attachRejected 反向通知 schema
export const attachRejectedInputSchema = z
  .object({
    sessionId: z.string().min(1).max(SESSION_ID_MAX),
    reason: z.enum(TERMINAL_ATTACH_REJECT_REASONS), // M23:单一来源
  })
  .strict();

export type CreateInput = TerminalCreateInput;
export type WriteInput = z.infer<typeof writeInputSchema>;
export type ResizeInput = z.infer<typeof resizeInputSchema>;
export type UpdateCwdInput = z.infer<typeof updateCwdInputSchema>;
export type IdOnlyInput = z.infer<typeof idOnlyInputSchema>;
export type AttachRejectedInput = z.infer<typeof attachRejectedInputSchema>;

// ── handlers ─────────────────────────────────────────────────

const ERR_NOT_FOUND = (id: string) =>
  Object.assign(new Error(`terminal not found: ${id}`), {
    code: ERROR_CODES.TERMINAL_NOT_FOUND,
  });

// race(R4):write 实际失败(PTY 在 has() 后退出 / server-node 拒写)→ 上抛,IPC 返 ok:false。
const ERR_WRITE_FAILED = (id: string) =>
  Object.assign(new Error(`terminal write failed: ${id}`), {
    code: ERROR_CODES.TERMINAL_WRITE_FAILED,
  });

function senderWindowOrThrow(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    throw Object.assign(new Error('no browser window'), {
      code: ERROR_CODES.TERMINAL_NO_WINDOW,
    });
  }
  return win;
}

function assertOwnedSession(
  sessionStore: Pick<typeof terminalSessions, 'get'>,
  id: string,
  win: BrowserWindow,
): void {
  const session = sessionStore.get(id);
  if (!session || session.ownerWindowId !== win.id) {
    throw ERR_NOT_FOUND(id);
  }
}

export function makeCreateHandler(deps?: {
  service?: typeof termService;
  sessionStore?: typeof terminalSessions;
  generateId?: () => string;
  resolveCwd?: (cwdHint?: string) => string;
}) {
  const service = deps?.service ?? termService;
  const sessionStore = deps?.sessionStore ?? terminalSessions;
  const generateId = deps?.generateId ?? (() => `term-${crypto.randomUUID()}`);
  const resolveCwd = deps?.resolveCwd ?? resolveTerminalCwd;

  return async (
    input: CreateInput,
    win: BrowserWindow,
    // 安全 S3:仅 MCP create_session 路径传 controllerToken(=调用方 ctx.callerSubject),
    // 把会话归属到该调用方;IPC 路径(renderer Cmd+T)不传 → user 终端不盖 controllerToken,
    // 任何 MCP 调用方都无权读控。renderer 不能经 createInputSchema 伪造此字段。
    opts?: { controllerToken?: string },
  ): Promise<{ id: string; cwd?: string; title?: string }> => {
    const shell = input.shell ?? getDefaultShell();
    if (!isAllowedShell(shell)) {
      throw Object.assign(new Error(`shell not in allowlist: ${shell}`), {
        code: ERROR_CODES.TERMINAL_FORBIDDEN_SHELL,
      });
    }
    // cwd 解析优先级:
    //   1. 显式入参 input.cwd(user 路径 Cmd+T / + 按钮已传 workspaceRoot)
    //   2. 入参 workspaceRoot(renderer 显式提示)
    //   3. main 端 windowId → workspaceRoot 映射(MCP agent 路径 renderer 无法
    //      显式传 cwd 时的回退;source-of-truth 是 renderer workspace.store 通过
    //      window:notify-root IPC 推送)
    const cwdHint =
      input.cwd ?? input.workspaceRoot ?? getWindowWorkspaceRoot(win.id) ?? undefined;
    const cwd = resolveCwd(cwdHint);
    const id = generateId();
    // MCP env(token / url)注入到所有 PTY:用户在 terminal 跑 claude / codex 时
    // 自动反连本机 MCP host。internalEnv 在后,防用户 env 覆盖内部 token。
    const { env: internalEnv, mcpToken } = mcpEnvProvider(win.id);
    const mergedEnv = { ...(input.env ?? {}), ...internalEnv };
    const title = input.title ?? input.name ?? sessionStore.nextDefaultTitle(win.id);
    // 先登记 session metadata(reservation),再 spawn PTY。PTY 可能在 createTerminal 的
    // await 期间就极速退出(如 `sh -c 'exit 0'` / 启动即失败的 shell),其 onExit →
    // cleanupSessionLocal → setExited(id) 需要 metadata 已存在;否则 setExited 因 id 不在
    // sessions map 而 no-op,exit 终态被丢 → 随后注册的 session 永远停在 exitCode:null 的
    // 假 live 态(stale panel「活着但已死」,write/resize 走 not-found)。先 add 让 setExited
    // 总能命中;create 失败回滚 remove(id)。(codex 复审 loop R19)
    sessionStore.add({
      id,
      title,
      cwd,
      originHint: input.originHint ?? 'user',
      ownerWindowId: win.id,
      // 跨平台:按真实 shell 路径标注引号族(renderer 拖拽文件据此引用,不再盲猜平台)。
      shellFamily: shellFamilyForPath(shell),
      ...(input.agentLabel !== undefined ? { agentLabel: input.agentLabel } : {}),
      ...(input.scoped !== undefined ? { scoped: input.scoped } : {}),
      ...(input.attachTarget !== undefined ? { attachTarget: input.attachTarget } : {}),
      ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
      ...(opts?.controllerToken !== undefined
        ? { controllerToken: opts.controllerToken }
        : {}),
    });
    // mcpToken 通过 meta 透传给 terminal.service.createTerminal, PTY exit cleanup 时 revoke
    try {
      await service.createTerminal(id, win, shell, input.args ?? [], cwd, mergedEnv, {
        mcpToken,
      });
    } catch (err) {
      sessionStore.remove(id);
      throw err;
    }
    // race(R31):add()(可见 reservation)在 createTerminal 的 await 之前,但 PTY 在 await 期间才
    // 真正建立。这段窗口内用户关 tab → makeRemoveHandler 删了 metadata,但当时 service.has(id)
    // 仍为 false(PTY 没建)→ 不 kill;随后 createTerminal resolve 出真实 PTY,而 metadata 已删 →
    // renderer 看不到也无法经 UI 关闭 = 不可见孤儿终端/进程。createTerminal resolve 后复查
    // reservation:若已不在 store(被 remove 取消;区别于 exit-during-create —— 那条 setExited
    // 保留 metadata 故 get(id) 仍在),立即 kill 刚建的 PTY 并以 CANCELLED 收场,不返回成功。
    if (!sessionStore.get(id)) {
      if (service.has(id)) service.kill(id);
      throw Object.assign(new Error(`terminal create cancelled: ${id}`), {
        code: ERROR_CODES.TERMINAL_CREATE_CANCELLED,
      });
    }
    return input.scoped ? { id, cwd, title } : { id };
  };
}

export function resolveTerminalCwd(cwdHint?: string): string {
  if (!cwdHint) {
    throw Object.assign(new Error('terminal cwd unresolved (no hint)'), {
      code: ERROR_CODES.TERMINAL_CWD_UNRESOLVED,
    });
  }
  try {
    if (fs.existsSync(cwdHint) && fs.statSync(cwdHint).isDirectory()) {
      return cwdHint;
    }
  } catch {
    // fall through to throw below
  }
  throw Object.assign(new Error(`terminal cwd invalid: ${cwdHint}`), {
    code: ERROR_CODES.TERMINAL_CWD_UNRESOLVED,
  });
}

export function makeListSessionsHandler(deps?: {
  sessionStore?: typeof terminalSessions;
}) {
  const sessionStore = deps?.sessionStore ?? terminalSessions;
  return (input: { ownerWindowId: number }): {
    sessions: readonly terminalSessions.MainTerminalSession[];
  } => ({
    sessions: sessionStore.getAll({ ownerWindowId: input.ownerWindowId }),
  });
}

export function makeWindowClosedCleanup(deps?: {
  service?: typeof termService;
  sessionStore?: typeof terminalSessions;
  cancelStopHookWaiters?: (windowId: number) => void;
}) {
  const service = deps?.service ?? termService;
  const sessionStore = deps?.sessionStore ?? terminalSessions;
  // 默认走模块级注入的 canceller(late-bind,容忍 broker 在窗口创建后才 wire)。
  const cancelStopHookWaiters =
    deps?.cancelStopHookWaiters ?? ((wid: number) => stopHookCanceller(wid));
  return (ownerWindowId: number): void => {
    const ids = sessionStore.removeByOwner(ownerWindowId);
    mcpRevokers().byWindow(ownerWindowId);
    // 提前结束该窗口仍在 block 的 await_stop_hook,避免挂到 timeout 才自愈(审计 #3)。
    cancelStopHookWaiters(ownerWindowId);
    for (const id of ids) {
      if (service.has(id)) service.kill(id);
    }
  };
}

export function makeRemoveHandler(deps?: {
  service?: typeof termService;
  sessionStore?: typeof terminalSessions;
}) {
  const service = deps?.service ?? termService;
  const sessionStore = deps?.sessionStore ?? terminalSessions;
  return (input: IdOnlyInput, win: BrowserWindow): void => {
    assertOwnedSession(sessionStore, input.id, win);
    // 立即删 metadata(用户点 X 立刻消失);PTY 在后台异步 SIGINT + 3s grace。
    sessionStore.remove(input.id);
    if (service.has(input.id)) service.kill(input.id);
  };
}

export function makeUpdateCwdHandler(deps?: {
  sessionStore?: typeof terminalSessions;
}) {
  const sessionStore = deps?.sessionStore ?? terminalSessions;
  return (input: UpdateCwdInput, win: BrowserWindow): void => {
    const session = sessionStore.get(input.id);
    if (!session || session.ownerWindowId !== win.id) {
      throw ERR_NOT_FOUND(input.id);
    }
    sessionStore.updateCwd(input.id, input.cwd);
  };
}

export function makeWriteHandler(deps?: {
  service?: typeof termService;
  sessionStore?: typeof terminalSessions;
}) {
  const service = deps?.service ?? termService;
  const sessionStore = deps?.sessionStore ?? terminalSessions;
  return async (input: WriteInput, win: BrowserWindow): Promise<void> => {
    assertOwnedSession(sessionStore, input.id, win);
    if (!service.has(input.id)) throw ERR_NOT_FOUND(input.id);
    // race(R4):await 真实写入结果;失败(check 后 PTY 退出 / 写拒绝)→ 抛 TERMINAL_WRITE_FAILED,
    // IPC 返 ok:false,让 renderer(A144)真正感知写入失败而非收到假成功。
    const ok = await service.write(input.id, input.data);
    if (!ok) throw ERR_WRITE_FAILED(input.id);
  };
}

export function makeResizeHandler(deps?: {
  service?: typeof termService;
  sessionStore?: typeof terminalSessions;
}) {
  const service = deps?.service ?? termService;
  const sessionStore = deps?.sessionStore ?? terminalSessions;
  return async (input: ResizeInput, win: BrowserWindow): Promise<void> => {
    assertOwnedSession(sessionStore, input.id, win);
    if (!service.has(input.id)) throw ERR_NOT_FOUND(input.id);
    // race(R96):await 真实 resize 结果并在失败时上抛 → IPC 返回 ok:false,让 renderer 感知
    // PTY resize 未成功、回滚 lastSize 以便同尺寸重试(否则 DOM/PTY 尺寸长期不一致)。
    const ok = await service.resize(input.id, input.cols, input.rows);
    if (!ok) throw ERR_NOT_FOUND(input.id);
  };
}

export function makeInterruptHandler(deps?: {
  service?: typeof termService;
  sessionStore?: typeof terminalSessions;
}) {
  const service = deps?.service ?? termService;
  const sessionStore = deps?.sessionStore ?? terminalSessions;
  return async (input: IdOnlyInput, win: BrowserWindow): Promise<void> => {
    assertOwnedSession(sessionStore, input.id, win);
    if (!service.has(input.id)) throw ERR_NOT_FOUND(input.id);
    // race(R12,R4 同款):await 真实中断结果;失败(check 后 PTY 退出 / 写拒绝)→ 抛
    // TERMINAL_WRITE_FAILED,IPC 返 ok:false,renderer 真正感知中断未送达。
    const ok = await service.interrupt(input.id);
    if (!ok) throw ERR_WRITE_FAILED(input.id);
  };
}

export function makeKillHandler(deps?: {
  service?: typeof termService;
  sessionStore?: typeof terminalSessions;
}) {
  const service = deps?.service ?? termService;
  const sessionStore = deps?.sessionStore ?? terminalSessions;
  return (input: IdOnlyInput, win: BrowserWindow): void => {
    assertOwnedSession(sessionStore, input.id, win);
    if (!service.has(input.id)) throw ERR_NOT_FOUND(input.id);
    service.kill(input.id);
  };
}

// topic-05: renderer 反向通知 main 该 agent session attach 失败;main 端
// remove session metadata + kill PTY。
// V1 简化:不做 main 端 preflight reservation,失败时 cleanup。
export function makeAttachRejectedHandler(deps?: {
  service?: typeof termService;
  sessionStore?: typeof terminalSessions;
}) {
  const service = deps?.service ?? termService;
  const sessionStore = deps?.sessionStore ?? terminalSessions;
  return (input: AttachRejectedInput, win: BrowserWindow): void => {
    assertOwnedSession(sessionStore, input.sessionId, win);
    console.warn(
      '[terminal-ipc] attach-rejected:',
      input.sessionId,
      'reason=',
      input.reason,
    );
    sessionStore.remove(input.sessionId);
    if (service.has(input.sessionId)) service.kill(input.sessionId);
  };
}

/**
 * sessions_changed 广播:严格 per-owner 路由,把按 ownerWindowId 过滤后的 session 快照
 * 推给每个未销毁窗口。terminalSessions 的 subscriber。
 *
 * race(R68,R63-R67 同族):isDestroyed() 检查后、send 前窗口可能销毁,send 抛
 * "Object has been destroyed"。裸抛会中断窗口循环 → 坏窗口之后的其它窗口漏收终端会话快照,
 * Dock/Terminal 面板停在旧 session 列表直到下一次 session 变化。每个窗口的 send 独立 try/catch,
 * 失败只跳过/记录并继续给其它窗口发送。导出供 R68 回归测试。
 */
export function broadcastSessionsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.send(
        TERMINAL_CHANNELS.SESSIONS_CHANGED,
        terminalSessions.getAll({ ownerWindowId: w.id }),
      );
    } catch (err) {
      console.error('[terminal] SESSIONS_CHANGED broadcast failed', err);
    }
  }
}

// ── 注册 ─────────────────────────────────────────────────────

export function registerTerminalIpc(): void {
  const trusted = defaultIsTrustedFrame;
  const createHandler = makeCreateHandler();
  const listSessionsHandler = makeListSessionsHandler();
  const writeHandler = makeWriteHandler();
  const resizeHandler = makeResizeHandler();
  const interruptHandler = makeInterruptHandler();
  const killHandler = makeKillHandler();
  const removeHandler = makeRemoveHandler();
  const attachRejectedHandler = makeAttachRejectedHandler();
  const updateCwdHandler = makeUpdateCwdHandler();
  const windowClosedCleanup = makeWindowClosedCleanup();

  const ownerScopedHandle = <I>(
    channel: string,
    schema: z.ZodType<I>,
    handler: (input: I, win: BrowserWindow) => unknown | Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown) =>
      processIpcCall(
        schema,
        async (input) => await handler(input, senderWindowOrThrow(event)),
        raw,
        event.senderFrame,
        trusted,
      ),
    );
  };

  // create 需要 win,单独走 processIpcCall 包 closure。
  ipcMain.handle(
    TERMINAL_CHANNELS.CREATE,
    async (event: IpcMainInvokeEvent, raw: unknown) =>
      processIpcCall(
        createInputSchema,
        async (input) => {
          const win = senderWindowOrThrow(event);
          return createHandler(input, win);
        },
        raw,
        event.senderFrame,
        trusted,
      ),
  );

  // list_sessions:Issue #28 Phase 1。从 sender 推断 ownerWindowId,renderer
  // 不自报。同 create 走 processIpcCall 包 closure。
  ipcMain.handle(
    TERMINAL_CHANNELS.LIST_SESSIONS,
    async (event: IpcMainInvokeEvent, raw: unknown) =>
      processIpcCall(
        noInputSchema,
        async () => {
          const win = senderWindowOrThrow(event);
          return listSessionsHandler({ ownerWindowId: win.id });
        },
        raw,
        event.senderFrame,
        trusted,
      ),
  );

  ownerScopedHandle(TERMINAL_CHANNELS.WRITE, writeInputSchema, writeHandler);
  ownerScopedHandle(TERMINAL_CHANNELS.RESIZE, resizeInputSchema, resizeHandler);
  ownerScopedHandle(TERMINAL_CHANNELS.INTERRUPT, idOnlyInputSchema, interruptHandler);
  ownerScopedHandle(TERMINAL_CHANNELS.KILL, idOnlyInputSchema, killHandler);
  ownerScopedHandle(TERMINAL_CHANNELS.DESTROY, idOnlyInputSchema, killHandler);
  ownerScopedHandle(TERMINAL_CHANNELS.REMOVE, idOnlyInputSchema, removeHandler);
  ownerScopedHandle(
    TERMINAL_CHANNELS.READ_HISTORY,
    idOnlyInputSchema,
    (input, win) => {
      assertOwnedSession(terminalSessions, input.id, win);
      return termService.getBufferSnapshot(input.id);
    },
  );
  ownerScopedHandle(
    TERMINAL_CHANNELS.ATTACH_REJECTED,
    attachRejectedInputSchema,
    attachRejectedHandler,
  );

  ipcMain.handle(
    UPDATE_CWD_CHANNEL,
    async (
      event: IpcMainInvokeEvent,
      rawOrId: unknown,
      rawCwd?: unknown,
    ) =>
      processIpcCall(
        updateCwdInputSchema,
        async (input) => {
          updateCwdHandler(input, senderWindowOrThrow(event));
        },
        typeof rawOrId === 'string'
          ? { id: rawOrId, cwd: rawCwd }
          : rawOrId,
        event.senderFrame,
        trusted,
      ),
  );

  // sessions_changed:严格 per-owner 路由 — 不论 user / agent,可见域只由
  // ownerWindowId 决定,与 listSessionsHandler 一致。
  // (topic-05 86c1799 曾给 agent session 开宽口径"广播到所有 window"以绕过
  // fallback 选错窗的问题,已回退 — 那是把 fallback bug 转嫁成 sessions 跨
  // window 漏出。正确路径:让 ctx.ownerWindowId 拿对窗,而非放宽广播。)
  terminalSessions.subscribe(broadcastSessionsChanged);

  // window 关闭:Issue #28 Phase 1。摘 metadata + kill 该 owner 的所有 PTY。
  // 用 'browser-window-created' 监听新建窗口,再为每个窗口挂 'closed'。
  // 这样主窗 / 新窗 / 测试动态创建的窗都覆盖。
  // 现有已开窗也需要挂 — registerTerminalIpc 调用时遍历一次。
  const attachClosed = (w: BrowserWindow): void => {
    w.once('closed', () => {
      windowClosedCleanup(w.id);
    });
  };
  for (const w of BrowserWindow.getAllWindows()) attachClosed(w);
  app.on('browser-window-created', (_event, w) => attachClosed(w));
}
