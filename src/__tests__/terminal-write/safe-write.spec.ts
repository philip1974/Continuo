import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chunkifyData,
  disposeQueue,
  safeWrite,
} from '../../panels/Terminal/safeWrite';

// 假 Terminal:只提供 write 方法用于断言
const makeFakeTerm = () => {
  const writes: string[] = [];
  return {
    instance: { write: (data: string) => writes.push(data) } as unknown as import('@xterm/xterm').Terminal,
    writes,
  };
};

describe('chunkifyData', () => {
  it('数据 ≤ chunkSize → 一片', () => {
    expect(chunkifyData('hello', 100)).toEqual(['hello']);
  });

  it('超出 → 切等长 chunks(最后一片可能短)', () => {
    expect(chunkifyData('abcdefghij', 3)).toEqual(['abc', 'def', 'ghi', 'j']);
  });

  it('空字符串 → 空数组', () => {
    expect(chunkifyData('', 100)).toEqual([]);
  });

  it('chunkSize 不影响数据完整性(拼回 = 原 data)', () => {
    const data = 'A'.repeat(50) + 'B'.repeat(30) + 'C'.repeat(20);
    const chunks = chunkifyData(data, 16);
    expect(chunks.join('')).toBe(data);
  });
});

describe('safeWrite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('单次 < 16KB → 立即一次 write', () => {
    const { instance, writes } = makeFakeTerm();
    safeWrite(instance, 'short');
    expect(writes).toEqual(['short']);
    disposeQueue(instance);
  });

  it('单次 ≤ 64KB(burst 范围内 ≤4 chunk)→ 全部同步立即写', () => {
    const { instance, writes } = makeFakeTerm();
    const big = 'x'.repeat(16 * 1024 * 3 + 100); // 4 chunks 总(3 完整 + 100B)
    safeWrite(instance, big);
    // 前 BURST_CHUNKS(4)同步直写,无需 setTimeout
    expect(writes.length).toBe(4);
    expect(writes.join('')).toBe(big);
    disposeQueue(instance);
  });

  it('单次 > 64KB(超 burst)→ 前 4 chunk 立即,第 5+ 走 8ms 节流', async () => {
    const { instance, writes } = makeFakeTerm();
    const big = 'x'.repeat(16 * 1024 * 5 + 100); // 6 chunks(5 完整 + 100B)
    safeWrite(instance, big);
    expect(writes.length).toBe(4); // 前 4 立即(burst)
    await vi.advanceTimersByTimeAsync(10);
    expect(writes.length).toBe(5);
    await vi.advanceTimersByTimeAsync(10);
    expect(writes.length).toBe(6);
    expect(writes.join('')).toBe(big);
    disposeQueue(instance);
  });

  it('连续 safeWrite 同 term → 顺序处理(不重入)', async () => {
    const { instance, writes } = makeFakeTerm();
    safeWrite(instance, 'A'.repeat(16 * 1024 + 1)); // 2 chunks
    safeWrite(instance, 'B'.repeat(16 * 1024 + 1)); // 2 chunks
    // 第一片立即;后续 setTimeout
    await vi.advanceTimersByTimeAsync(50);
    // 应有 4 chunks 全部 flushed,且顺序 = A...B...
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes.join('')).toBe('A'.repeat(16 * 1024 + 1) + 'B'.repeat(16 * 1024 + 1));
    disposeQueue(instance);
  });

  it('disposeQueue 后 queue 被释放(同 term 再 safeWrite 可继续)', () => {
    const { instance, writes } = makeFakeTerm();
    safeWrite(instance, 'first');
    disposeQueue(instance);
    safeWrite(instance, 'second');
    expect(writes).toEqual(['first', 'second']);
  });

  it('disposeQueue 会取消节流中的旧 timer,不再写已释放 term', async () => {
    const { instance, writes } = makeFakeTerm();
    const big = 'x'.repeat(16 * 1024 * 5 + 100); // 6 chunks

    safeWrite(instance, big);
    expect(writes.length).toBe(4);

    disposeQueue(instance);
    await vi.advanceTimersByTimeAsync(50);

    expect(writes.length).toBe(4);
  });
});
