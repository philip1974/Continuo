export const PLUGIN_SHELL_STREAM_CHANNELS = {
  START: 'plugin-shell-stream:start',
  ABORT: 'plugin-shell-stream:abort',
  /** main -> renderer event */
  EVENT: 'plugin-shell-stream:event',
} as const;

// 边界(E175,E168-E174 同族 IPC ingress 纵深防御):plugin-shell-stream:event preload handler 此前
// 完全信任 TS 类型直接读 payload.streamId/kind/payload。畸形事件(null/非对象/streamId 非串/非法 kind/
// stdout·stderr payload 非二进制/exit payload 非 {exitCode,signal})→ listener 抛(null.streamId)、
// 喂空/错 chunk 或非法 exitInfo 给插件 stream(done/chunks 状态异常甚至挂起)。本纯函数把畸形分类,
// preload 据此:not-ours 忽略 / invalid 合成 exit 收敛 / 合法照常处理。单一来源,preload 复用 + 单测。
export type ShellStreamParsed =
  // 无法归属到任何 stream(null/非对象/streamId 非串)—— 不可断定属于本 stream,handler 仅 drop+warn,
  // **不**合成 exit(否则一个无主畸形事件会误杀所有活跃 stream)。
  | { readonly kind: 'unattributable' }
  // streamId 合法但 ≠ 本 stream —— 正常多 stream 并存,静默忽略。
  | { readonly kind: 'not-ours' }
  // streamId == 本 stream 但 kind/payload 形态非法 —— 本 stream 已坏,handler 合成 exit 收敛。
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'exit';
      readonly exitCode: number | null;
      readonly signal: string | null;
    }
  | {
      readonly kind: 'chunk';
      readonly stream: 'stdout' | 'stderr';
      readonly bytes: Uint8Array;
    };

export function parseShellStreamEvent(
  payload: unknown,
  expectedStreamId: string,
): ShellStreamParsed {
  if (payload === null || typeof payload !== 'object') {
    return { kind: 'unattributable' };
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.streamId !== 'string') return { kind: 'unattributable' };
  if (p.streamId !== expectedStreamId) return { kind: 'not-ours' };
  // 以下:确属本 stream;kind/payload 非法 → 'invalid'(收敛本 stream)。
  if (p.kind === 'exit') {
    const ep = p.payload;
    if (ep === null || typeof ep !== 'object') return { kind: 'invalid' };
    const e = ep as Record<string, unknown>;
    const exitCode = e.exitCode;
    const signal = e.signal;
    if (!(exitCode === null || typeof exitCode === 'number')) {
      return { kind: 'invalid' };
    }
    if (!(signal === null || typeof signal === 'string')) {
      return { kind: 'invalid' };
    }
    return { kind: 'exit', exitCode, signal };
  }
  if (p.kind === 'stdout' || p.kind === 'stderr') {
    const data = p.payload;
    // 经 IPC structured-clone,main 端 Buffer 到达 renderer 为 Uint8Array(Buffer 是其子类)。
    if (!(data instanceof Uint8Array)) return { kind: 'invalid' };
    return { kind: 'chunk', stream: p.kind, bytes: new Uint8Array(data) };
  }
  return { kind: 'invalid' };
}
