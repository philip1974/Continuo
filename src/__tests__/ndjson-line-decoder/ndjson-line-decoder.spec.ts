// 边界(E135,E131/E132 跨 chunk 解码同族):NDJSON 流式行解码器须跨 socket chunk 正确还原多字节
// UTF-8 字符。外部 splitLines 的 `buffer + chunk.toString()` 逐 chunk 解码会把被切开的多字节字符
// 各自变成 U+FFFD(中文/韩文/emoji 参数损坏 / JSON 解析失败)。
import { describe, it, expect, vi } from 'vitest';
import { createNdjsonLineDecoder } from '../../../electron/main/lib/ndjson-line-decoder';
import { utf8ByteLength, utf8BytesExceed } from '../../../electron/shared/utf8-byte-length';

describe('createNdjsonLineDecoder (E135)', () => {
  it('多字节字符被拆到两个 chunk → 整体正确还原', () => {
    // {"q":"中"} 的 UTF-8;把 '中'(E4 B8 AD)拆在两 chunk 边界。
    const json = '{"q":"中"}\n';
    const bytes = Buffer.from(json, 'utf8');
    // 找 '中' 的起始字节,在其中间切。'{"q":"' = 6 字节,'中' 占 6..8。
    const cut = 7; // 切在 '中' 的第 2 字节(B8)前
    const dec = createNdjsonLineDecoder();
    const l1 = dec.push(bytes.subarray(0, cut)).lines;
    const l2 = dec.push(bytes.subarray(cut)).lines;
    const lines = [...l1, ...l2];
    expect(lines).toEqual(['{"q":"中"}']);
    expect(JSON.parse(lines[0]!)).toEqual({ q: '中' });
  });

  it('emoji(4 字节)逐字节拆 → 还原', () => {
    const json = '{"e":"😀"}\n';
    const bytes = Buffer.from(json, 'utf8');
    const dec = createNdjsonLineDecoder();
    const lines: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      lines.push(...dec.push(bytes.subarray(i, i + 1)).lines);
    }
    expect(lines).toEqual(['{"e":"😀"}']);
    expect(JSON.parse(lines[0]!)).toEqual({ e: '😀' });
  });

  it('一次多行 + \\r\\n 剥离 + 残行保留在 buffered', () => {
    const dec = createNdjsonLineDecoder();
    const lines = dec.push(Buffer.from('a\r\nb\nc', 'utf8')).lines;
    expect(lines).toEqual(['a', 'b']);
    expect(dec.buffered).toBe('c'); // 残行(未终结)
  });

  it('剥离 CRLF 的尾随 CR 不调用 replace 正则', () => {
    const dec = createNdjsonLineDecoder();
    const replaceSpy = vi.spyOn(String.prototype, 'replace');

    try {
      expect(dec.push(Buffer.from('a\r\nb\n', 'utf8')).lines).toEqual([
        'a',
        'b',
      ]);
      const trimCrRegexCalls = replaceSpy.mock.calls.filter(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '\\r$',
      );
      expect(trimCrRegexCalls).toHaveLength(0);
    } finally {
      replaceSpy.mockRestore();
    }
  });

  it('ASCII 跨 chunk 正常', () => {
    const dec = createNdjsonLineDecoder();
    const l1 = dec.push(Buffer.from('hel', 'utf8')).lines;
    const l2 = dec.push(Buffer.from('lo\n', 'utf8')).lines;
    expect([...l1, ...l2]).toEqual(['hello']);
  });
  // 边界(E218,E214 下推):maxLines 钳定本次产出完整行数,达到即 overflow + 清残行(不 split 全量物化)。
  it('E218 maxLines:行数超上限 → overflow=true,产出 ≤ maxLines 行,残行清空', () => {
    const dec = createNdjsonLineDecoder();
    // 5 行(均终结)+ maxLines=3 → 产出前 3 行,overflow,残行清空。
    const r = dec.push(Buffer.from('a\nb\nc\nd\ne\n', 'utf8'), 3);
    expect(r.lines).toEqual(['a', 'b', 'c']);
    expect(r.overflow).toBe(true);
    expect(dec.buffered).toBe(''); // overflow 清残行
  });

  it('E218 maxLines:行数未超 → overflow=false,产出全部、残行保留(行为同旧 split)', () => {
    const dec = createNdjsonLineDecoder();
    const r = dec.push(Buffer.from('a\nb\nc', 'utf8'), 10);
    expect(r.lines).toEqual(['a', 'b']);
    expect(r.overflow).toBe(false);
    expect(dec.buffered).toBe('c'); // 残行保留
  });

  it('E218 maxLines 省略 → 产出全部完整行(向后兼容)', () => {
    const dec = createNdjsonLineDecoder();
    const r = dec.push(Buffer.from('x\ny\n', 'utf8'));
    expect(r.lines).toEqual(['x', 'y']);
    expect(r.overflow).toBe(false);
  });
});

// perf P2(stdio 大请求行 O(n²)):此前每个 data 分块都对整个残行重扫 '\n'(indexOf 从 0)并由调用方
// 对整个残行重算 UTF-8 字节数。decoder 现增量维护 bufferedBytes(口径 = 残行解码串的 UTF-8 字节数,
// 与旧 utf8BytesExceed(buffered) 完全一致:坏字节 → U+FFFD 计 3、未完成的多字节尾不计),无 '\n' 的分块
// 只扫本分块。
describe('createNdjsonLineDecoder bufferedBytes / 增量扫描(perf)', () => {
  /** 参考实现:旧算法(全量拼接解码 + 从 0 切分)。 */
  function reference() {
    const td = new TextDecoder('utf-8');
    let residual = '';
    return (chunk: Buffer): { lines: string[]; residual: string } => {
      residual += td.decode(chunk, { stream: true });
      const parts = residual.split('\n');
      residual = parts.pop()!;
      return { lines: parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)), residual };
    };
  }
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }
  const pieces = ['a', '{"q":1}', '中', '😀', 'é', '\n', '\r\n', '�'];

  it('随机分块(含跨 chunk 的多字节字符 / 坏字节 / CRLF):行与残行同旧算法,bufferedBytes ≡ utf8ByteLength(buffered)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const segs: Buffer[] = [];
      for (let i = 0; i < 200; i++) {
        if (r() < 0.05) segs.push(Buffer.from([0xff])); // 非法字节 → U+FFFD
        else if (r() < 0.03) segs.push(Buffer.from([0xe4, 0xb8])); // 截断的 3 字节序列
        else segs.push(Buffer.from(pieces[Math.floor(r() * pieces.length)]!, 'utf8'));
      }
      const all = Buffer.concat(segs);
      const dec = createNdjsonLineDecoder();
      const ref = reference();
      let off = 0;
      while (off < all.length) {
        const n = 1 + Math.floor(r() * 9);
        const chunk = all.subarray(off, off + n);
        off += n;
        const got = dec.push(chunk);
        const want = ref(chunk);
        expect(got.lines).toEqual(want.lines);
        expect(dec.buffered).toBe(want.residual);
        expect(dec.bufferedBytes).toBe(utf8ByteLength(dec.buffered));
      }
    }
  });

  it('超限判定等价:bufferedBytes > max ⇔ utf8BytesExceed(buffered, max)(多字节残行跨上限)', () => {
    const max = 30;
    const dec = createNdjsonLineDecoder();
    const bytes = Buffer.from('中'.repeat(20), 'utf8'); // 60 字节,无换行
    for (let i = 0; i < bytes.length; i += 4) {
      dec.push(bytes.subarray(i, i + 4));
      expect(dec.bufferedBytes > max).toBe(utf8BytesExceed(dec.buffered, max));
    }
    expect(dec.bufferedBytes).toBe(60);
  });

  it('overflow 清残行 → bufferedBytes 归零;换行后只计最后一个换行之后的字节', () => {
    const dec = createNdjsonLineDecoder();
    dec.push(Buffer.from('中中', 'utf8'));
    expect(dec.bufferedBytes).toBe(6);
    dec.push(Buffer.from('x\n😀', 'utf8'));
    expect(dec.bufferedBytes).toBe(4);
    dec.push(Buffer.from('\na\nb\nc', 'utf8'), 1);
    expect(dec.bufferedBytes).toBe(0);
    expect(dec.buffered).toBe('');
  });

  it('无换行的大行按 8KB 分块喂入:换行扫描总量线性(不对整个残行逐块重扫)', () => {
    const orig = String.prototype.indexOf;
    let scanned = 0;
    const spy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      this: string,
      search: string,
      from?: number,
    ) {
      if (search === '\n') scanned += this.length - (from ?? 0);
      return orig.call(this, search, from);
    });
    try {
      const dec = createNdjsonLineDecoder();
      const chunk = Buffer.alloc(8192, 0x61);
      const n = 128; // 1MiB
      for (let i = 0; i < n; i++) dec.push(chunk);
      dec.push(Buffer.from('\n'));
      expect(dec.bufferedBytes).toBe(0);
      // 线性:≈ 总字节数的常数倍;旧实现 ≈ n²/2 × 8KB(约 64 倍总量)。
      expect(scanned).toBeLessThanOrEqual(3 * n * chunk.length);
    } finally {
      spy.mockRestore();
    }
  });
});
