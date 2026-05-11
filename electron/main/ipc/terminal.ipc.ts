// Terminal IPC 接入(M-Terminal Step T2 + Agent Terminal MCP P1)。
// 8 invoke 通道 + 5 push event 通道。schemas / handlers 单独 export 给 spec 测;
// registerTerminalIpc() 真注册 + 订阅 sessions_changed 广播给所有 BrowserWindow。

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { z } from 'zod';
import { defaultIsTrustedFrame, processIpcCall, safeHandle } from '../safe-handle';
import { TERMINAL_CHANNELS } from '../../shared/terminal-channels';
import { getDefaultShell, isAllowedShell } from '../../shared/terminal-shells';
import * as termService from '../services/terminal.service';
import * as terminalSessions from '../services/terminal-sessions.service';
import * as terminalBuffer from '../services/terminal-buffer.service';

// ── 常量 ─────────────────────────────────────────────────────
const MAX_WRITE_CHARS = 2_000_000; // ~2MB UTF-8 字符上限,与 Mind 1MB 字节同档

// ── MCP env provider(由 main/index.ts 在 mcp host 启动后注入)──
// 默认空 → 不注入 MCP 信息;启动 host 后调 setMcpEnvProvider 注册真函数。
let mcpEnvProvider: () => Record<string, string> = () => ({});

export function setMcpEnvProvider(fn: () => Record<string, string>): void {
  mcpEnvProvider = fn;
}

// ── schemas(.strict() 拒未知字段) ────────────────────────────

export const createInputSchema = z
  .object({
    shell: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    // P1 metadata 真相源在 main:这些字段创建时入 sessions service。
    // P1 调用方暂只传 user 类型(MCP create_session 的 agent 类型留 P2)。
    name: z.string().optional(),
    originHint: z.enum(['user', 'agent']).optional(),
    agentLabel: z.string().optional(),
  })
  .strict();

export const writeInputSchema = z
  .object({
    id: z.string().min(1),
    data: z.string().max(MAX_WRITE_CHARS),
  })
  .strict();

export const resizeInputSchema = z
  .object({
    id: z.string().min(1),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(500),
  })
  .strict();

export const idOnlyInputSchema = z
  .object({ id: z.string().min(1) })
  .strict();

export const noInputSchema = z.object({}).strict();

export type CreateInput = z.infer<typeof createInputSchema>;
export type WriteInput = z.infer<typeof writeInputSchema>;
export type ResizeInput = z.infer<typeof resizeInputSchema>;
export type IdOnlyInput = z.infer<typeof idOnlyInputSchema>;

// ── handlers ─────────────────────────────────────────────────

const ERR_NOT_FOUND = (id: string) =>
  Object.assign(new Error(`terminal not found: ${id}`), {
    code: 'TERMINAL_NOT_FOUND',
  });

export function makeCreateHandler(deps?: {
  service?: typeof termService;
  sessionStore?: typeof terminalSessions;
  generateId?: () => string;
  resolveCwd?: (cwdHint?: string) => string;
}) {
  const service = deps?.service ?? termService;
  const sessionStore = deps?.sessionStore ?? terminalSessions;
  const generateId = deps?.generateId ?? (() => `term-${crypto.randomUUID()}`);
  const resolveCwd = deps?.resolveCwd ?? ((c) => c ?? os.homedir());

  return (input: CreateInput, win: BrowserWindow): { id: string } => {
    const shell = input.shell ?? getDefaultShell();
    if (!isAllowedShell(shell)) {
      throw Object.assign(new Error(`shell not in allowlist: ${shell}`), {
        code: 'TERMINAL_FORBIDDEN_SHELL',
      });
    }
    const cwd = resolveCwd(input.cwd);
    const id = generateId();
    // MCP env(token / url)注入到所有 PTY:用户在 terminal 跑 claude / codex 时
    // 自动反连本机 MCP host。input.env 在后(让显式覆盖优先)。
    const mergedEnv = { ...mcpEnvProvider(), ...(input.env ?? {}) };
    service.createTerminal(id, win, shell, input.args ?? [], cwd, mergedEnv);
    sessionStore.add({
      id,
      title: input.name ?? sessionStore.nextDefaultTitle(),
      cwd,
      originHint: input.originHint ?? 'user',
      ownerWindowId: win.id,
      ...(input.agentLabel !== undefined ? { agentLabel: input.agentLabel } : {}),
    });
    return { id };
  };
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
}) {
  const service = deps?.service ?? termService;
  const sessionStore = deps?.sessionStore ?? terminalSessions;
  return (ownerWindowId: number): void => {
    const ids = sessionStore.removeByOwner(ownerWindowId);
    for (const id of ids) {
      if (service.has(id)) service.kill(id);
    }
  };
}

export function makeRemoveHandler(deps?: {
  service?: typeof termService;
  sessionStore?: typeof terminalSessions;
  buffer?: typeof terminalBuffer;
}) {
  const service = deps?.service ?? termService;
  const sessionStore = deps?.sessionStore ?? terminalSessions;
  const buffer = deps?.buffer ?? terminalBuffer;
  return (input: IdOnlyInput): void => {
    // 立即删 metadata(用户点 X 立刻消失);PTY 在后台异步 SIGINT + 3s grace。
    sessionStore.remove(input.id);
    if (service.has(input.id)) service.kill(input.id);
    // 用户主动关 → 释放 buffer(自然 exit 时不清,留给 agent read_output 看)
    buffer.destroy(input.id);
  };
}

export const writeHandler = (input: WriteInput): void => {
  if (!termService.has(input.id)) throw ERR_NOT_FOUND(input.id);
  termService.write(input.id, input.data);
};

export const resizeHandler = (input: ResizeInput): void => {
  if (!termService.has(input.id)) throw ERR_NOT_FOUND(input.id);
  termService.resize(input.id, input.cols, input.rows);
};

export const interruptHandler = (input: IdOnlyInput): void => {
  if (!termService.has(input.id)) throw ERR_NOT_FOUND(input.id);
  termService.interrupt(input.id);
};

export const killHandler = (input: IdOnlyInput): void => {
  if (!termService.has(input.id)) throw ERR_NOT_FOUND(input.id);
  termService.kill(input.id);
};

// ── 注册 ─────────────────────────────────────────────────────

export function registerTerminalIpc(): void {
  const trusted = defaultIsTrustedFrame;
  const createHandler = makeCreateHandler();
  const listSessionsHandler = makeListSessionsHandler();
  const removeHandler = makeRemoveHandler();
  const windowClosedCleanup = makeWindowClosedCleanup();

  // create 需要 win,单独走 processIpcCall 包 closure(其它走 safeHandle)
  ipcMain.handle(
    TERMINAL_CHANNELS.CREATE,
    async (event: IpcMainInvokeEvent, raw: unknown) =>
      processIpcCall(
        createInputSchema,
        async (input) => {
          const win = BrowserWindow.fromWebContents(event.sender);
          if (!win) {
            throw Object.assign(new Error('no browser window'), {
              code: 'TERMINAL_NO_WINDOW',
            });
          }
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
          const win = BrowserWindow.fromWebContents(event.sender);
          if (!win) {
            throw Object.assign(new Error('no browser window'), {
              code: 'TERMINAL_NO_WINDOW',
            });
          }
          return listSessionsHandler({ ownerWindowId: win.id });
        },
        raw,
        event.senderFrame,
        trusted,
      ),
  );

  safeHandle(TERMINAL_CHANNELS.WRITE, writeInputSchema, writeHandler, trusted);
  safeHandle(TERMINAL_CHANNELS.RESIZE, resizeInputSchema, resizeHandler, trusted);
  safeHandle(TERMINAL_CHANNELS.INTERRUPT, idOnlyInputSchema, interruptHandler, trusted);
  safeHandle(TERMINAL_CHANNELS.KILL, idOnlyInputSchema, killHandler, trusted);
  safeHandle(TERMINAL_CHANNELS.DESTROY, idOnlyInputSchema, killHandler, trusted);
  safeHandle(TERMINAL_CHANNELS.REMOVE, idOnlyInputSchema, removeHandler, trusted);

  // sessions_changed:Issue #28 Phase 1。按 owner 路由,只把该 window 自己的
  // sessions 推给该 window。其它 window 收到的快照仅含它们自己的 sessions。
  terminalSessions.subscribe(() => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      const owned = terminalSessions.getAll({ ownerWindowId: w.id });
      w.webContents.send(TERMINAL_CHANNELS.SESSIONS_CHANGED, owned);
    }
  });

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
