import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebFrameMain } from 'electron';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { IpcResult } from '../shared/ipc-result';
import { IPC_ERR } from '../shared/ipc-result';
import { formatZodErrorCapped } from './lib/format-zod-error';
import { MAX_WINDOW_URL_LEN } from '../shared/url-limits';
import {
  boundedObjectAdmissible,
  MAX_BOUNDED_OBJECT_KEYS,
  MAX_BOUNDED_OBJECT_KEY_LEN,
} from '../shared/bounded-input';

// 边界(E157,E73 同族):BAD_INPUT 错误经 formatZodErrorCapped 限幅,但 handler 抛出的 Error 的
// code/message 此前原样回传。任一 handler 把外部错误/超长路径/子进程 stderr 拼进 Error.message,
// 都会经 IPC structured-clone 把巨量字符串送回 renderer → 主/renderer 内存与 UI 放大。统一对回传
// 的 code/message 限幅(两个 processIpcCall* 共用 helper),与 BAD_INPUT 限幅边界对齐。
export const ERR_CODE_MAX = 256;
export const ERR_MESSAGE_MAX = 8192;

function capErrText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max})` : s;
}

/** 把 catch 到的 err 规整为限幅后的 IpcResult 错误(code≤ERR_CODE_MAX,message≤ERR_MESSAGE_MAX)。 */
function toCappedErrorResult(err: unknown): IpcResult<never> {
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : IPC_ERR.HANDLER_ERROR;
  const message = typeof e.message === 'string' ? e.message : String(err);
  if (code === IPC_ERR.HANDLER_ERROR) {
    console.error('[ipc] unhandled error in handler:', err);
  }
  return {
    ok: false,
    code: capErrText(code, ERR_CODE_MAX),
    message: capErrText(message, ERR_MESSAGE_MAX),
  };
}

// 边界(E256,E255 同族 / generic IPC 入口收口):processIpcCall* 直接对 rawInput 执行
// schema.safeParse()。大量 IPC schema 是 `.strict()` object,畸形 renderer/preload 调用可在 1MiB 级
// structured-clone 后塞海量未知短 key —— Zod 会先**枚举全部 key** 并为 unrecognized_keys 构造 issue/
// message 数组,错误串 cap(formatZodErrorCapped,E73)在这之后才生效 → 单请求即可让 main 进程在
// schema 阶段 CPU/内存放大,且影响面比 MCP(E255)更广(fs/window/plugins/terminal/shell 所有 IPC)。
// 故在 safeParse **之前**对 plain object 做通用 bounded 预检:限制自有 key 数与单 key 长度,超限直接
// BAD_INPUT 不进入 Zod。非 plain object(string/number/array 等合法 schema 输入)不拦,交给 schema。
// 边界(E257 重构):核心逻辑收口到 shared boundedObjectAdmissible(三入口单一来源消漂移),此处只做
// 领域错误文案映射,保持本入口既有契约(常量名 / message)。
export const MAX_IPC_INPUT_KEYS = MAX_BOUNDED_OBJECT_KEYS;
export const MAX_IPC_INPUT_KEY_LEN = MAX_BOUNDED_OBJECT_KEY_LEN;

/**
 * 边界(E256):IPC rawInput 的 bounded 预检(纯函数,便于测试)。在 safeParse 前调用。
 * 委托 shared boundedObjectAdmissible,失败时映射成 IPC 领域文案。
 */
export function ipcInputBounded(
  rawInput: unknown,
): { ok: true } | { ok: false; message: string } {
  const r = boundedObjectAdmissible(rawInput);
  if (r.ok) return { ok: true };
  return {
    ok: false,
    message:
      r.reason === 'too-many-keys'
        ? 'ipc input: too many keys'
        : 'ipc input: key too long',
  };
}

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
  // 边界(E196 同族,isPopoutUrl 对偶):defaultIsTrustedFrame 在每次 IPC 调用本函数对 frame.url 做
  // new URL(O(N) 解析)。畸形超长 frame.url 否则每次 IPC ingress 被完整解析。超 MAX_WINDOW_URL_LEN 必
  // 非法,fail-closed 视为不受信(false)。startsWith 是 O(1) 前缀,不受影响。
  if (typeof url !== 'string' || url.length > MAX_WINDOW_URL_LEN) return false;
  if (trustedRendererPathname === null) return url.startsWith('file://');
  if (!url.startsWith('file://')) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    return decodeURIComponent(u.pathname) === trustedRendererPathname;
  } catch {
    return false;
  }
}

let cachedExpectedRendererUrl: string | null = null;
let cachedExpectedRendererOrigin: string | null = null;

function getExpectedRendererOrigin(expected: string): string | null {
  if (cachedExpectedRendererUrl === expected) return cachedExpectedRendererOrigin;
  cachedExpectedRendererUrl = expected;
  try {
    cachedExpectedRendererOrigin = new URL(expected).origin;
  } catch {
    cachedExpectedRendererOrigin = null;
  }
  return cachedExpectedRendererOrigin;
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

  // 边界(E256):safeParse 前 bounded 预检(plain object key 数 / 单 key 长度),挡海量未知 key
  // 在 Zod .strict() 枚举 + unrecognized_keys issue 构造阶段放大(E73 错误串 cap 在 parse 后才生效)。
  const bounded = ipcInputBounded(rawInput);
  if (!bounded.ok) {
    return { ok: false, code: IPC_ERR.BAD_INPUT, message: bounded.message };
  }

  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      code: IPC_ERR.BAD_INPUT,
      // 边界(E73):错误串经 cap,防 .strict() schema 大量未知 key 产生无界 message。
      message: formatZodErrorCapped(parsed.error),
    };
  }

  try {
    const data = await handler(parsed.data);
    return { ok: true, data };
  } catch (err) {
    return toCappedErrorResult(err); // 边界(E157):限幅 handler 抛错 code/message
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
  // 边界(E196 同族):本函数在每次 IPC 调用,frame.url 经两处 new URL(O(N) 解析)。超长 frame.url
  // fail-closed 视为不受信,绝不进入任何 new URL 解析(isTrustedRendererFileUrl 已自带同闸,这里再挡
  // 下面的 dev origin 比较分支)。
  if (typeof frame.url !== 'string' || frame.url.length > MAX_WINDOW_URL_LEN) {
    return false;
  }
  // 安全 S1:只信真实 renderer 入口 file URL(prod 注册后严格),不再信任意 file://。
  if (isTrustedRendererFileUrl(frame.url)) return true;

  const expected = process.env['ELECTRON_RENDERER_URL'];
  // 边界(E303,E196/E302 同族 / dev URL 解析兄弟入口):expected(ELECTRON_RENDERER_URL)此前无长度上限 ——
  // frame.url 已限长(line 193),但 expected 每次 IPC 调用都 new URL 解析一次,开发误配/OS 上界超长 env
  // 会被反复 O(N) 解析。对齐 frame.url 的 MAX_WINDOW_URL_LEN 闸(任何真实 dev URL 远在内),超长 fail-closed。
  if (!expected || expected.length > MAX_WINDOW_URL_LEN) return false;
  const expectedOrigin = getExpectedRendererOrigin(expected);
  if (expectedOrigin === null) return false;

  try {
    return new URL(frame.url).origin === expectedOrigin;
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
  // 边界(E256):safeParse 前 bounded 预检(同 processIpcCall,ctx-aware 孪生入口一并收口)。
  const bounded = ipcInputBounded(rawInput);
  if (!bounded.ok) {
    return { ok: false, code: IPC_ERR.BAD_INPUT, message: bounded.message };
  }
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: IPC_ERR.BAD_INPUT, message: formatZodErrorCapped(parsed.error) }; // 边界(E73):错误串 cap
  }
  try {
    const data = await handler(parsed.data, { event });
    return { ok: true, data };
  } catch (err) {
    return toCappedErrorResult(err); // 边界(E157):限幅 handler 抛错 code/message
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
