import { describe, expect, it } from 'vitest';
import { arraysEqual } from '../array-equal';

describe('arraysEqual', () => {
  it('同一引用 → true(不调用比较器)', () => {
    const a = [{ v: 1 }];
    let calls = 0;
    expect(arraysEqual(a, a, () => (calls++, false))).toBe(true);
    expect(calls).toBe(0);
  });

  it('长度不同 → false', () => {
    expect(arraysEqual([1, 2], [1])).toBe(false);
    expect(arraysEqual([], [1])).toBe(false);
  });

  it('默认按 === 逐元素比较,顺序敏感', () => {
    expect(arraysEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(arraysEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(arraysEqual([{}], [{}])).toBe(false);
  });

  it('自定义比较器按字段判等', () => {
    const eq = (x: { id: string }, y: { id: string }) => x.id === y.id;
    expect(arraysEqual([{ id: 'x' }], [{ id: 'x' }], eq)).toBe(true);
    expect(arraysEqual([{ id: 'x' }], [{ id: 'y' }], eq)).toBe(false);
  });

  it('两个空数组 → true', () => {
    expect(arraysEqual([], [])).toBe(true);
  });
});
