// 边界(E124,E57/E64/E65 响应体上限族的正确实现):按**真实字节**流式累计读取 Response,超
// maxBytes 立即取消并抛,而非「await r.text() 把整个响应读入内存后再判 text.length」。
//
// 旧实现两个缺陷:
//  1. `await r.text()` 在大小检查**之前**就把整个 body 读入 renderer/main 内存 —— Content-Length
//     缺失/伪造/chunked 时(预检 cl=0 放行),超大响应已被完整读入才拒,内存/CPU 放大。
//  2. `text.length` 是 UTF-16 code unit 数,**不是字节数** —— 多字节 UTF-8(如 CJK 3 bytes/字)响应
//     的真实字节数可远大于 text.length,使「字节上限」被绕过(byteLength > max 但 text.length ≤ max)。
//
// 本 helper 流式累计 chunk.byteLength,超限即 cancel + 抛;读完后整体 TextDecoder.decode(正确处理
// 跨 chunk 的多字节字符)。renderer 与 main 共用(electron/shared)。
export async function readResponseTextCapped(
  r: Response,
  maxBytes: number,
  tooLargeError: () => Error,
): Promise<string> {
  // Content-Length 诚实时早退(省一次完整读);但 header 可缺失/伪造,不能作权威闸。
  const cl = Number(r.headers.get('content-length') ?? '0');
  if (Number.isFinite(cl) && cl > maxBytes) throw tooLargeError();

  const body = r.body;
  if (!body) {
    // 无 ReadableStream(罕见环境 / 某些 mock):回退 text() + **真实字节**校验(修缺陷 2)。
    const text = await r.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw tooLargeError();
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel(); // 取消下游,不再累计/decode
      throw tooLargeError();
    }
    chunks.push(value);
  }
  // 累计已 ≤ maxBytes;整体 decode(跨 chunk 多字节字符正确还原)。
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}
