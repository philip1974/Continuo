// main 热路径的 UTF-8 字节计数用原生 Buffer.byteLength(与 shared utf8ByteLength 口径一致,单独代理 3 字节),
// 纯 JS 逐字符计数在 PTY 大量输出时慢约 15 倍(每 MB 输出多 ~2.6ms main 线程)。
// 以及:flushedOnQuit 随窗口 closed 清理,不随关窗次数单调增长。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { utf8ByteLength } from '../../shared/utf8-byte-length';

const read = (p: string): string => readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('main 热路径字节计数', () => {
  it('Buffer.byteLength 与 utf8ByteLength 口径一致(含单独代理、代理对、CJK)', () => {
    for (const s of ['', 'abc', '中文', '\uD800', '\uD800中', '😀', 'a\uDC00b', 'x'.repeat(1000) + '🌍']) {
      expect(Buffer.byteLength(s, 'utf8')).toBe(utf8ByteLength(s));
    }
  });

  it('terminal.service 的输出节流计数与 ndjson 解码器用原生 Buffer.byteLength', () => {
    expect(read('services/terminal.service.ts')).toMatch(
      /inst\.bytesPerSecond \+= Buffer\.byteLength\(chunk, 'utf8'\)/,
    );
    expect(read('lib/ndjson-line-decoder.ts')).not.toMatch(/import \{ utf8ByteLength \}/);
  });

  it('窗口 closed 时清理 flushedOnQuit', () => {
    const src = read('index.ts');
    const closedBlock = src.slice(src.indexOf("win.on('closed', () => {\n    e2eQuitTrace(`win ${windowId} closed`);"));
    expect(closedBlock.slice(0, 400)).toMatch(/flushedOnQuit\.delete\(windowId\)/);
  });
});
