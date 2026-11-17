// 性能 P1:稳态持续输出时 renderer 端写入合并(见 README「写入合并」)。
// 主进程 5ms 合批 → 每 ~5-6ms 一条小 terminal:data;safeWrite 按 chunk 数节流(burst 后每 8ms
// 只写 1 个 chunk,与大小无关)→ 到达 ~166 条/s > 排空 ~125 条/s,积压与显示延迟线性增长。
// 合并器把一个短窗口内的小块拼成接近 CHUNK_SIZE 的一次 safeWrite,排空能力回到按字节计。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createOutputCoalescer,
  OUTPUT_COALESCE_LEADING_CHUNKS,
  OUTPUT_COALESCE_MAX_CHARS,
  OUTPUT_COALESCE_WINDOW_MS,
} from '../../panels/Terminal/output-coalescer';

let writes: string[];
const make = () => createOutputCoalescer((d) => writes.push(d));

beforeEach(() => {
  writes = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('terminal 输出写入合并', () => {
  it('空闲时首块立即写出(不引入首字节延迟)', () => {
    const c = make();
    c.push('$ ');
    expect(writes).toEqual(['$ ']);
    c.dispose();
  });

  it('空闲后紧随的第二块也立即写出:跨主进程 5ms 合批边界的同一屏重绘(A+B)不被拆到不同帧', () => {
    const c = make();
    c.push('frame-part-A');
    vi.advanceTimersByTime(5);
    c.push('frame-part-B');
    expect(writes).toEqual(['frame-part-A', 'frame-part-B']);
    c.dispose();
  });

  it('窗口内多条小块合并为一次写,内容与顺序不变', () => {
    const c = make();
    const parts = Array.from({ length: 20 }, (_, i) => `line-${i}\r\n`);
    for (const p of parts) c.push(p);
    // 空闲后前 OUTPUT_COALESCE_LEADING_CHUNKS 块立即,其余在窗口结束时合成一次
    expect(writes.length).toBe(OUTPUT_COALESCE_LEADING_CHUNKS);
    vi.advanceTimersByTime(OUTPUT_COALESCE_WINDOW_MS);
    expect(writes.length).toBe(OUTPUT_COALESCE_LEADING_CHUNKS + 1);
    expect(writes.join('')).toBe(parts.join(''));
  });

  it('持续输出(每 5ms 一条):写调用次数远少于到达条数,且拼接结果一致', () => {
    const c = make();
    const parts: string[] = [];
    for (let i = 0; i < 200; i++) {
      const p = `${i}:${'x'.repeat(2000)}\n`;
      parts.push(p);
      c.push(p);
      vi.advanceTimersByTime(5);
    }
    vi.advanceTimersByTime(OUTPUT_COALESCE_WINDOW_MS);
    expect(writes.join('')).toBe(parts.join(''));
    expect(writes.length).toBeLessThan(200 / 2);
    // 每次写都不超过一个 safeWrite chunk(16KB)→ 每次 safeWrite 只占 1 个节流槽
    for (const w of writes) expect(w.length).toBeLessThanOrEqual(OUTPUT_COALESCE_MAX_CHARS);
  });

  it('累计达到阈值立即写出,不等窗口结束', () => {
    const c = make();
    c.push('a'); // 空闲后前两块立即
    c.push('L');
    const half = 'b'.repeat(OUTPUT_COALESCE_MAX_CHARS / 2);
    c.push(half);
    c.push(half);
    expect(writes).toEqual(['a', 'L', half + half]);
    c.dispose();
  });

  it('加入新块会超阈值 → 先写出已缓冲部分,新块留待合并(每次写 ≤ 阈值)', () => {
    const c = make();
    c.push('a');
    c.push('L');
    const big = 'b'.repeat(OUTPUT_COALESCE_MAX_CHARS - 10);
    c.push(big);
    c.push('c'.repeat(20));
    expect(writes).toEqual(['a', 'L', big]);
    vi.advanceTimersByTime(OUTPUT_COALESCE_WINDOW_MS);
    expect(writes.join('')).toBe('a' + 'L' + big + 'c'.repeat(20));
  });

  it('单块本身超阈值 → 立即整块写出(交给 safeWrite 切片),顺序不乱', () => {
    const c = make();
    c.push('a');
    c.push('b');
    const huge = 'h'.repeat(OUTPUT_COALESCE_MAX_CHARS * 3);
    c.push(huge);
    expect(writes).toEqual(['a', 'b', huge]);
    c.dispose();
  });

  it('窗口结束且无新数据 → 回到空闲,下一块再次立即写出', () => {
    const c = make();
    c.push('1');
    c.push('2');
    vi.advanceTimersByTime(OUTPUT_COALESCE_WINDOW_MS); // 前两块已立即写出,空窗口 → 空闲
    c.push('3');
    expect(writes).toEqual(['1', '2', '3']);
    c.dispose();
  });

  it('dispose 丢弃未写出的缓冲且不再写(与 disposeQueue 丢弃队列语义一致)', () => {
    const c = make();
    c.push('a');
    c.push('L');
    c.push('pending');
    c.dispose();
    vi.advanceTimersByTime(OUTPUT_COALESCE_WINDOW_MS * 4);
    c.push('late');
    expect(writes).toEqual(['a', 'L']);
  });
});
