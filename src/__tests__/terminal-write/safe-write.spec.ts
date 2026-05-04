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

  it('单次 > 16KB → 多次 write,8ms 一片', async () => {
    const { instance, writes } = makeFakeTerm();
    const big = 'x'.repeat(16 * 1024 * 3 + 100); // 3 个完整 chunk + 100B
    safeWrite(instance, big);
    expect(writes.length).toBe(1); // 第一片立即
    await vi.advanceTimersByTimeAsync(10);
    expect(writes.length).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(writes.length).toBe(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(writes.length).toBe(4); // 4 个 chunk(16K * 3 + 100B)
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
});
