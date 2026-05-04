// Terminal IPC 接入(M-Terminal Step T2)。
// 6 个 invoke 通道 + 4 个 push event 通道(在 service 内 webContents.send)。
// schemas / handlers 单独 export 给 spec 测;registerTerminalIpc() 真注册。

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { z } from 'zod';
import { defaultIsTrustedFrame, processIpcCall, safeHandle } from '../safe-handle';
import { TERMINAL_CHANNELS } from '../../shared/terminal-channels';
import { getDefaultShell, isAllowedShell } from '../../shared/terminal-shells';
import * as termService from '../services/terminal.service';

// ── 常量 ─────────────────────────────────────────────────────
const MAX_WRITE_CHARS = 2_000_000; // ~2MB UTF-8 字符上限,与 Mind 1MB 字节同档

// ── schemas(.strict() 拒未知字段) ────────────────────────────

export const createInputSchema = z
  .object({
    shell: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
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
  generateId?: () => string;
  resolveCwd?: (cwdHint?: string) => string;
}) {
  const service = deps?.service ?? termService;
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
    service.createTerminal(id, win, shell, input.args ?? [], cwd, input.env);
    return { id };
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

  safeHandle(TERMINAL_CHANNELS.WRITE, writeInputSchema, writeHandler, trusted);
  safeHandle(TERMINAL_CHANNELS.RESIZE, resizeInputSchema, resizeHandler, trusted);
  safeHandle(TERMINAL_CHANNELS.INTERRUPT, idOnlyInputSchema, interruptHandler, trusted);
  safeHandle(TERMINAL_CHANNELS.KILL, idOnlyInputSchema, killHandler, trusted);
  safeHandle(TERMINAL_CHANNELS.DESTROY, idOnlyInputSchema, killHandler, trusted);
}
