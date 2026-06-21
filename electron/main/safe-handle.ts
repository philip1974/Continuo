import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebFrameMain } from 'electron';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { IpcResult } from '../shared/ipc-result';
import { IPC_ERR } from '../shared/ipc-result';

// ── 安全 S1:受信 renderer 入口 file URL 收紧 ──────────────────────────
// 旧实现把**任意** file:// frame/弹窗当作受信并注入 preload。攻击:renderer 内代码
// (如恶意插件)写一个 evil.html 到磁盘再 window.open('file:///.../evil.html'),新窗
// 拿到全量 Continuo preload + 被 defaultIsTrustedFrame 信任 → 越权 fs/shell IPC,绕过
// 插件权限模型。改为只信**真实 renderer 入口 index.html** 的 file URL(精确 pathname
// 比对,忽略 query/hash)。index.ts 启动时 setTrustedRendererFile(RENDERER_FILE) 注册。
let trustedRendererPathname: string | null = null;

/** index.ts 启动时注入真实 renderer 入口绝对路径(prod). */
export function setTrustedRendererFile(absPath: string): void {
  try {
    trustedRendererPathname = decodeURIComponent(
      pathToFileURL(absPath).pathname,
    );
  } catch {
    trustedRendererPathname = null;
  }
}

/** 单测重置,避免跨用例串注册态. */
export function _resetTrustedRendererFileForTest(): void {
  trustedRendererPathname = null;
}

/**
 * file:// URL 是否指向受信 renderer 入口。**未注册**(单测 / 极早期)退回宽松(任意
 * file://);**已注册**(prod,index.ts 启动即注册)严格:pathname 必须精确等于入口
 * index.html 的 pathname。攻击者写的 `file:///tmp/evil.html` / 插件目录下任意 html
 * 都不匹配 → 拒。
 */
export function isTrustedRendererFileUrl(url: string): boolean {
  if (trustedRendererPathname === null) return url.startsWith('file://');
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    return decodeURIComponent(u.pathname) === trustedRendererPathname;
  } catch {
    return false;
  }
}

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
  // 安全 S1:只信真实 renderer 入口 file URL(prod 注册后严格),不再信任意 file://。
  if (isTrustedRendererFileUrl(frame.url)) return true;

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
