// perf:debug variables / evaluate 的值截断此前逐码点调用 Buffer.byteLength(64KiB 截断 ≈ 64K 次 JS↔C++ 跨界,
// 单值 ~1.3ms,一次 variables 请求可阻塞 main 50–90ms)。改为逐码元累加字节;输出须与旧实现逐字相同。
import { describe, expect, it } from 'vitest';
import { truncateUtf8 } from '../../shared/utf8-byte-length';

function reference(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false };
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const next = bytes + Buffer.byteLength(char, 'utf8');
    if (next > maxBytes) break;
    bytes = next;
    end += char.length;
  }
  return { value: value.slice(0, end), truncated: true };
}

describe('truncateUtf8', () => {
  const samples = [
    '',
    'abc',
    'a'.repeat(100),
    '中文字符'.repeat(30),
    'é'.repeat(50),
    '😀'.repeat(40),
    '\uD800x\uDC00y\uD83D',
    'ab😀cd\uD800􏿿e',
    'mix中😀é\uDC00'.repeat(20),
  ];
  it('任意上限下与逐码点 Buffer.byteLength 参考实现逐字相同', () => {
    for (const s of samples) {
      for (let max = 0; max <= 160; max++) {
        expect(truncateUtf8(s, max)).toEqual(reference(s, max));
      }
    }
  });

  it('不再逐字符调用 Buffer.byteLength(最多整串判长一次)', () => {
    const orig = Buffer.byteLength;
    let calls = 0;
    Buffer.byteLength = ((...args: Parameters<typeof Buffer.byteLength>) => {
      calls++;
      return orig(...args);
    }) as typeof Buffer.byteLength;
    try {
      truncateUtf8('x'.repeat(10_000), 100);
    } finally {
      Buffer.byteLength = orig;
    }
    expect(calls).toBeLessThanOrEqual(1);
  });
});
