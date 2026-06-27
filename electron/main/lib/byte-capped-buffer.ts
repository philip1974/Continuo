// 边界(E131,E62/E125 同族):按**真实 UTF-8 字节**累积流式输出(如 git stderr)并在字节上限处截断,
// decode 延后到使用处整体进行。
//
// 直接 `acc += String(chunk)` 有两个 bug:
//  1. 逐 chunk `String(chunk)` 把跨 chunk 边界的多字节 UTF-8 字符各自解码 → 两半都成 U+FFFD(乱码)。
//  2. `acc.length`(UTF-16 code unit 数)≠ 字节;多字节输出会突破「字节」上限。
// 本 helper 累积原始 Buffer、按字节计数/截断,`text()` 时 `Buffer.concat(...).toString('utf8')` 一次性
// 解码(跨 chunk 多字节字符正确还原;字节截断处末尾的半个字符由 toString 容错为 U+FFFD)。
export interface ByteCappedBuffer {
  /** 追加一段输出(Buffer);已截断后忽略。 */
  push(chunk: Buffer): void;
  /** 是否已达字节上限被截断。 */
  readonly truncated: boolean;
  /** 整体解码为 UTF-8 字符串(累积字节 ≤ maxBytes)。 */
  text(): string;
}

export function createByteCappedBuffer(maxBytes: number): ByteCappedBuffer {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk: Buffer): void {
      if (truncated) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = maxBytes - bytes;
      if (buf.length >= remaining) {
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
    text(): string {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}
