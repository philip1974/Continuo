// 边界(E125,E124 同族):字节上限必须按**真实 UTF-8 字节**校验,而非 `String.length`
//(UTF-16 code unit 数)。多字节字符(CJK 3 bytes/字、emoji 4 bytes/2 code units)使
// byteLength 可达 code-unit 数的数倍 → 用 .length 当字节上限会让超限内容(写盘/持久化/IPC)绕过
// backstop,造成磁盘/内存放大。renderer 无 Buffer,main 有但 Buffer.byteLength 仍分配计算;此处用
// 纯 code-point 迭代,O(n) 时间 O(1) 额外空间,renderer + main 共用。
//
// 不变式:UTF-8 byteLength >= UTF-16 code-unit 数(每字符 UTF-8 字节数 >= 其 code unit 数)。

/** s 的 UTF-8 字节数(与 TextEncoder 一致,含 lone surrogate → U+FFFD = 3 bytes)。 */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      // 边界(E126):高代理**仅当紧跟低代理**才是合法 astral pair(4 bytes,消费 2 code unit)。
      // 否则为 lone surrogate,TextEncoder 编码为 U+FFFD(3 bytes)且**不消费**下一字符 —— 无条件
      // +4/跳过会对「lone 高代理 + 多字节字符」(如 '\uD800中' 真 6 bytes)严重 undercount,绕过字节上限。
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3; // lone 高代理 → U+FFFD
      }
    } else bytes += 3; // 含 lone 低代理(0xDC00-0xDFFF)→ U+FFFD(3 bytes)
  }
  return bytes;
}

/**
 * s 的 UTF-8 字节数是否 > maxBytes(带提前退出,避免对超大串全量计数)。
 * 因 byteLength >= s.length,s.length > maxBytes 时可直接判超限,无需迭代。
 */
export function utf8BytesExceed(s: string, maxBytes: number): boolean {
  if (s.length > maxBytes) return true;
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      // 边界(E126):仅合法 astral pair 才 4 bytes/跳过;lone 高代理 → U+FFFD(3 bytes)不跳过。
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
    if (bytes > maxBytes) return true;
  }
  return false;
}
