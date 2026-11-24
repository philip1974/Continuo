// 边界(E131,E62/E125 同族):按**真实 UTF-8 字节**累积流式输出(如 git stderr)并在字节上限处截断,
// decode 延后到使用处整体进行。
//
// 直接 `acc += String(chunk)` 有两个 bug:
//  1. 逐 chunk `String(chunk)` 把跨 chunk 边界的多字节 UTF-8 字符各自解码 → 两半都成 U+FFFD(乱码)。
//  2. `acc.length`(UTF-16 code unit 数)≠ 字节;多字节输出会突破「字节」上限。
// 本 helper 累积原始 Buffer、按字节计数/截断,`text()` 时 `Buffer.concat(...).toString('utf8')` 一次性
// 解码(跨 chunk 多字节字符正确还原;字节截断处末尾的半个字符由 toString 容错为 U+FFFD)。
export interface ByteCappedBuffer {
  /** 追加一段输出(Buffer);写满后再来的字节丢弃并记为截断。 */
  push(chunk: Buffer): void;
  /** 是否**确实丢了字节**(输出恰好等于上限、之后没有更多数据 → false)。 */
  readonly truncated: boolean;
  /** 已累积到字节上限(之后的数据都会被丢弃;流式调用方据此摘掉 data 监听)。 */
  readonly full: boolean;
  /** 整体解码为 UTF-8 字符串(累积字节 ≤ maxBytes)。 */
  text(): string;
}

export function createByteCappedBuffer(maxBytes: number): ByteCappedBuffer {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk: Buffer): void {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (buf.length === 0) return;
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (buf.length > remaining) {
        chunks.push(buf.subarray(0, remaining)); // 字节边界截断(末尾可能切在多字节中)
        bytes = maxBytes;
        truncated = true;
      } else {
        chunks.push(buf);
        bytes += buf.length;
      }
    },
    get truncated(): boolean {
      return truncated;
    },
    get full(): boolean {
      return bytes >= maxBytes;
    },
    text(): string {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}
