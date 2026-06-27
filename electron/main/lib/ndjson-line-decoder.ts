// 边界(E135,E131/E132 跨 chunk 解码同族):NDJSON 流式行解码器。socket data 事件的 Buffer chunk
// 可能切在 UTF-8 多字节字符中间;直接 `chunk.toString()` 逐 chunk 解码会把被切开的字符各自变成
// U+FFFD(中文/韩文/emoji 参数随机损坏 / JSON 解析失败)。本解码器用 `TextDecoder({stream:true})`
// 在 decode 调用间缓存未完成的多字节序列,跨 chunk 正确还原后再按 '\n' 分行。
//
// (Continuo 侧替代 @continuo-terminal/server-node 的 splitLines —— 后者 `buffer + chunk.toString()`
// 有上述跨 chunk 拆字 bug;此处不改外部包,在 Continuo 调用点收口。)
export interface NdjsonPushResult {
  /** 本次喂入后已终结(\n)的完整行(尾随 \r 已剥),最多 maxLines 条。 */
  readonly lines: string[];
  /** maxLines 提供且本次完整行数超过它 → true。调用方应按畸形处理(parse error + 断开)。 */
  readonly overflow: boolean;
}

export interface NdjsonLineDecoder {
  /**
   * 喂入一段 socket 数据,返回其中已终结(\n)的完整行(尾随 \r 已剥)。
   * maxLines:本次产出的完整行数上限。达到即停止扫描、置 overflow、清残行(避免 residual.split('\n')
   * 一次性物化巨大行数组 —— 海量短行/空行的内存放大,E218,E214 下推到 decoder)。
   */
  push(chunk: Buffer, maxLines?: number): NdjsonPushResult;
  /** 当前未终结的残行(供调用方做字节上限背压检查)。 */
  readonly buffered: string;
}

export function createNdjsonLineDecoder(): NdjsonLineDecoder {
  const decoder = new TextDecoder('utf-8'); // 默认 fatal:false → lone/坏序列 → U+FFFD(不抛)
  let residual = '';
  return {
    push(chunk: Buffer, maxLines?: number): NdjsonPushResult {
      // stream:true → 末尾未完成的多字节序列留待下次 decode(跨 chunk 正确拼接)。
      residual += decoder.decode(chunk, { stream: true });
      // 边界(E218,E214 下推):索引扫描逐行产出,不 residual.split('\n') 全量物化 —— 畸形客户端发
      // 海量短行/空行时,split 会一次分配巨大数组(逃过调用方的后置行数 cap)。达到 maxLines 立即停 +
      // overflow + 清残行(调用方会断开)。maxLines 省略时退化为产出全部完整行(行为同旧 split)。
      const lines: string[] = [];
      let start = 0;
      let overflow = false;
      for (;;) {
        const nl = residual.indexOf('\n', start);
        if (nl === -1) break;
        if (maxLines !== undefined && lines.length >= maxLines) {
          overflow = true;
          break;
        }
        lines.push(residual.slice(start, nl).replace(/\r$/, ''));
        start = nl + 1;
      }
      residual = overflow ? '' : residual.slice(start);
      return { lines, overflow };
    },
    get buffered(): string {
      return residual;
    },
  };
}
