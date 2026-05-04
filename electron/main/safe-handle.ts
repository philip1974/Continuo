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
