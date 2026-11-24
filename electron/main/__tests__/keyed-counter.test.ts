import { describe, expect, it } from 'vitest';
import { createKeyedCounter } from '../lib/keyed-counter';

describe('createKeyedCounter', () => {
  it('inc 累加、get 读计数,未出现的 key 读 0', () => {
    const c = createKeyedCounter<number>();
    c.inc(1);
    c.inc(1);
    c.inc(2);
    expect(c.get(1)).toBe(2);
    expect(c.get(2)).toBe(1);
    expect(c.get(3)).toBe(0);
    expect(c.total()).toBe(3);
  });

  it('dec 减到 0 即删 key(has / keys 不再出现),total 同步', () => {
    const c = createKeyedCounter<string>();
    c.inc('a');
    c.inc('a');
    c.inc('b');
    c.dec('a');
    expect(c.has('a')).toBe(true);
    c.dec('a');
    expect(c.has('a')).toBe(false);
    expect([...c.keys()]).toEqual(['b']);
    expect(c.total()).toBe(1);
  });

  it('dec 不存在的 key 是 no-op(不出现负数、不动 total)', () => {
    const c = createKeyedCounter<number>();
    c.inc(1);
    c.dec(2);
    expect(c.has(2)).toBe(false);
    expect(c.get(2)).toBe(0);
    expect(c.total()).toBe(1);
  });

  it('delete 整个 key 清零并扣减 total;clear 全清', () => {
    const c = createKeyedCounter<number>();
    c.inc(1);
    c.inc(1);
    c.inc(2);
    c.delete(1);
    expect(c.has(1)).toBe(false);
    expect(c.total()).toBe(1);
    c.delete(9); // 不存在:no-op
    expect(c.total()).toBe(1);
    c.clear();
    expect([...c.keys()]).toEqual([]);
    expect(c.total()).toBe(0);
  });
});
