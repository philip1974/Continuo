// 边界(E125,E124 同族):字节上限必须按**真实 UTF-8 字节**校验,而非 `String.length`
//(UTF-16 code unit 数)。多字节字符(CJK 3 bytes/字、emoji 4 bytes/2 code units)使
// byteLength 可达 code-unit 数的数倍 → 用 .length 当字节上限会让超限内容(写盘/持久化/IPC)绕过
// backstop,造成磁盘/内存放大。renderer + main 共用:main 有 Buffer 时走原生 Buffer.byteLength(不分配,
// 1MB ASCII ~0.16ms;纯 JS 逐字符 1.4–3.1ms),renderer(sandbox 无 Buffer)回退纯 code-point 迭代
//(O(n) 时间 O(1) 额外空间)。两者口径一致(lone surrogate 均按 U+FFFD 3 字节)。
//
// 不变式:UTF-8 byteLength >= UTF-16 code-unit 数(每字符 UTF-8 字节数 >= 其 code unit 数)。

type ByteLengthHost = { byteLength(s: string, enc: 'utf8'): number };

// perf:模块加载时探测原生 Buffer.byteLength(main / Node 有;renderer sandbox 无,electron-vite 也不注入
// Buffer polyfill)。用口径探针校验(lone 高代理 + CJK = 6、代理对 = 4、lone 低代理 = 3)—— 若某环境注入了
// 口径不同的 Buffer polyfill,不采用,回退 JS,保证语义与 TextEncoder 一致。调用时经 host 取方法(不缓存
// 函数引用),与常规 Buffer.byteLength 调用等价。
const nativeHost: ByteLengthHost | null = (() => {
  try {
    const host = (globalThis as { Buffer?: { byteLength?: unknown } }).Buffer;
    if (!host || typeof host.byteLength !== 'function') return null;
    const h = host as ByteLengthHost;
    return h.byteLength('\uD800中', 'utf8') === 6 &&
      h.byteLength('😀', 'utf8') === 4 &&
      h.byteLength('\uDC00a', 'utf8') === 4
      ? h
      : null;
  } catch {
    return null;
  }
})();

// 纯 JS 计数;累计 > stopAbove 时提前返回(返回值此时只保证 > stopAbove)。
function jsByteLength(s: string, stopAbove: number): number {
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
    if (bytes > stopAbove) return bytes;
  }
  return bytes;
}

/** s 的 UTF-8 字节数(与 TextEncoder 一致,含 lone surrogate → U+FFFD = 3 bytes)。 */
export function utf8ByteLength(s: string): number {
  return nativeHost ? nativeHost.byteLength(s, 'utf8') : jsByteLength(s, Infinity);
}

/**
 * s 的 UTF-8 字节数是否 > maxBytes(带提前退出,避免对超大串全量计数)。
 * 因 byteLength >= s.length,s.length > maxBytes 时可直接判超限,无需迭代。
 * 又因 byteLength <= 3 × s.length(BMP 字符 ≤3 字节/code unit,代理对 4 字节/2 code unit,lone 代理 →
 * U+FFFD 3 字节/1 code unit),s.length × 3 <= maxBytes 时必不超限,同样无需迭代(perf)。
 * 落入 (maxBytes/3, maxBytes] 区间才真正计数:有原生 byteLength 时整串原生计数(仍远快于 JS 早停循环),
 * 否则 JS 循环超限即停。
 */
export function utf8BytesExceed(s: string, maxBytes: number): boolean {
  if (s.length > maxBytes) return true;
  if (s.length * 3 <= maxBytes) return false;
  if (nativeHost) return nativeHost.byteLength(s, 'utf8') > maxBytes;
  return jsByteLength(s, maxBytes) > maxBytes;
}

/**
 * 按 UTF-8 字节上限截断(不切开代理对)。逐码元累加字节而非逐码点调 Buffer.byteLength:后者每字符一次 JS↔C++
 * 跨界,64KiB 截断约 64K 次(单值 ~1.3ms),variables 展开一批大字符串时阻塞 main 50–90ms。口径与
 * utf8ByteLength / jsByteLength 一致:<0x80→1、<0x800→2、合法代理对→4、其余(含孤立代理,编码为 U+FFFD)→3。
 */
export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (!utf8BytesExceed(value, maxBytes)) return { value, truncated: false };
  let bytes = 0;
  let end = 0;
  const n = value.length;
  while (end < n) {
    const c = value.charCodeAt(end);
    let units = 1;
    let size: number;
    if (c < 0x80) size = 1;
    else if (c < 0x800) size = 2;
    else if (c >= 0xd800 && c <= 0xdbff && end + 1 < n) {
      const d = value.charCodeAt(end + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        size = 4;
        units = 2;
      } else size = 3;
    } else size = 3;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += units;
  }
  return { value: value.slice(0, end), truncated: true };
}
