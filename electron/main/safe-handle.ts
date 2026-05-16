import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebFrameMain } from 'electron';
import { z } from 'zod';
import type { IpcResult } from '../shared/ipc-result';
import { IPC_ERR } from '../shared/ipc-result';

// 测试与生产共享的 frame 形状。生产环境是 Electron WebFrameMain,
// 单测里只 mock { url } 即可,不引 electron 类型负担。
export type FrameLike = Pick<WebFrameMain, 'url'> | null;

export type IsTrustedFrame = (frame: FrameLike) => boolean;

export type SafeHandler<I, O> = (input: I) => Promise<O> | O;

/**
 * 纯函数版 IPC 处理:校验 + parse + 调 handler + 包成 IpcResult。
 * 不依赖 ipcMain,可单测。
 */
export async function processIpcCall<I, O>(
  schema: z.ZodType<I>,
  handler: SafeHandler<I, O>,
  rawInput: unknown,
  senderFrame: FrameLike,
  isTrustedFrame: IsTrustedFrame,
): Promise<IpcResult<O>> {
  if (!isTrustedFrame(senderFrame)) {
    return {
      ok: false,
      code: IPC_ERR.DENIED,
      message: 'sender frame is not trusted',
    };
  }

  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: IPC_ERR.BAD_INPUT,
      message: parsed.error.issues.map((i) => i.message).join('; '),
    };
  }

  try {
    const data = await handler(parsed.data);
    return { ok: true, data };
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    const code = typeof e.code === 'string' ? e.code : IPC_ERR.HANDLER_ERROR;
    const message =
      typeof e.message === 'string' ? e.message : String(err);
    if (code === IPC_ERR.HANDLER_ERROR) {
      console.error('[ipc] unhandled error in handler:', err);
    }
    return { ok: false, code, message };
  }
}

/**
 * ipcMain.handle 的安全包装。生产代码用这个,单测走 processIpcCall。
 */
export function safeHandle<I, O>(
  channel: string,
  schema: z.ZodType<I>,
  handler: SafeHandler<I, O>,
  isTrustedFrame: IsTrustedFrame,
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown) => {
    return processIpcCall(schema, handler, raw, event.senderFrame, isTrustedFrame);
  });
}

/**
 * 默认的可信 frame 判定:
 * - prod 走 file:// 协议加载 renderer
 * - dev 走 ELECTRON_RENDERER_URL(electron-vite 注入)
 * 跨 origin 一律拒绝(含 popout 子 frame 被注入 iframe 等情况)。
 */
export function defaultIsTrustedFrame(frame: FrameLike): boolean {
  if (!frame || !frame.url) return false;
  if (frame.url.startsWith('file://')) return true;

  const expected = process.env['ELECTRON_RENDERER_URL'];
  if (!expected) return false;

  try {
    return new URL(frame.url).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

/** ctx-aware handler:接受 IpcMainInvokeEvent 第二参,用于 sender 反查等场景. */
export type SafeHandlerWithCtx<I, O> = (
  input: I,
  ctx: { event: IpcMainInvokeEvent },
) => Promise<O> | O;

/**
 * 纯函数版 ctx-aware IPC:同 processIpcCall 行为,handler 多收一个 { event } 参数。
 * 业务错误一律走 throw with .code,catch 块统一形成 {ok:false, code, message}。
 */
export async function processIpcCallWithCtx<I, O>(
  schema: z.ZodType<I>,
  handler: SafeHandlerWithCtx<I, O>,
  rawInput: unknown,
  event: IpcMainInvokeEvent,
  isTrustedFrame: IsTrustedFrame,
): Promise<IpcResult<O>> {
  if (!isTrustedFrame(event.senderFrame)) {
    return { ok: false, code: IPC_ERR.DENIED, message: 'sender frame is not trusted' };
  }
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: IPC_ERR.BAD_INPUT, message: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  try {
    const data = await handler(parsed.data, { event });
    return { ok: true, data };
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    const code = typeof e.code === 'string' ? e.code : IPC_ERR.HANDLER_ERROR;
    const message = typeof e.message === 'string' ? e.message : String(err);
    if (code === IPC_ERR.HANDLER_ERROR) {
      console.error('[ipc] unhandled error in handler:', err);
    }
    return { ok: false, code, message };
  }
}

/** ipcMain.handle 包装的 ctx-aware 版本. */
export function safeHandleWithCtx<I, O>(
  channel: string,
  schema: z.ZodType<I>,
  handler: SafeHandlerWithCtx<I, O>,
  isTrustedFrame: IsTrustedFrame,
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown) => {
    return processIpcCallWithCtx(schema, handler, raw, event, isTrustedFrame);
  });
}
