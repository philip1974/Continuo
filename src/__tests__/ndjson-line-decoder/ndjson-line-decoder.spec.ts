// 边界(E135,E131/E132 跨 chunk 解码同族):NDJSON 流式行解码器须跨 socket chunk 正确还原多字节
// UTF-8 字符。外部 splitLines 的 `buffer + chunk.toString()` 逐 chunk 解码会把被切开的多字节字符
// 各自变成 U+FFFD(中文/韩文/emoji 参数损坏 / JSON 解析失败)。
import { describe, it, expect, vi } from 'vitest';
import { createNdjsonLineDecoder } from '../../../electron/main/lib/ndjson-line-decoder';

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
