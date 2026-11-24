export const PLUGIN_SHELL_STREAM_CHANNELS = {
  START: 'plugin-shell-stream:start',
  ABORT: 'plugin-shell-stream:abort',
  /** main -> renderer event */
  EVENT: 'plugin-shell-stream:event',
} as const;

// 插件 execStream 迭代器 yield 的单个 chunk(preload 产出、renderer scoped app 转发,两侧共用此一份)。
// 迭代器结束值为 void(`{ value: undefined, done: true }`),用类型表达结束语义,免 `undefined as never`。
export type ShellChunk = { stream: 'stdout' | 'stderr'; chunk: Uint8Array };

// 边界(E175,E168-E174 同族 IPC ingress 纵深防御):plugin-shell-stream:event preload handler 此前
// 完全信任 TS 类型直接读 payload.streamId/kind/payload。畸形事件(null/非对象/streamId 非串/非法 kind/
// stdout·stderr payload 非二进制/exit payload 非 {exitCode,signal})→ listener 抛(null.streamId)、
// 喂空/错 chunk 或非法 exitInfo 给插件 stream(done/chunks 状态异常甚至挂起)。本纯函数把畸形分类,
// preload 据此:invalid 合成 exit 收敛 / 合法照常处理。单一来源,preload 复用 + 单测。
// 归属(payload 是对象且 streamId 命中某条活跃流)由 preload 的单 listener 分发器先行判定:无主畸形
// payload 在那里 warn+drop,不会到达本函数(否则一个无主畸形事件会误杀所有活跃 stream)。
export type ShellStreamParsed =
  // kind/payload 形态非法 —— 该 stream 已坏,handler 合成 exit 收敛。
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

export function parseShellStreamEvent(payload: object): ShellStreamParsed {
  const p = payload as Record<string, unknown>;
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
