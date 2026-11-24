import { describe, expect, it, vi } from 'vitest';
import { trySend } from '../lib/try-send';

describe('trySend', () => {
  it('送达 → true', () => {
    const send = vi.fn();
    expect(trySend({ send, isDestroyed: () => false }, 'ch', { a: 1 })).toBe(true);
    expect(send).toHaveBeenCalledWith('ch', { a: 1 });
  });

  it('目标缺失 / 已销毁 → false,不调 send', () => {
    const send = vi.fn();
    expect(trySend(null, 'ch', 1)).toBe(false);
    expect(trySend({ send, isDestroyed: () => true }, 'ch', 1)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('send 抛错(检查后才销毁的竞态)→ false,不冒泡', () => {
    const send = vi.fn(() => {
      throw new Error('Object has been destroyed');
    });
    expect(trySend({ send }, 'ch', 1)).toBe(false);
  });
});
