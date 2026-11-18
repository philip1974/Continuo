// 查表 helper 的单元规范(见 ./README.md)。
import { describe, it, expect } from 'vitest';
import { ownValue } from '../../../electron/shared/own-value';

describe('ownValue', () => {
  it('自有属性 → 返回值;原型成员名 → undefined', () => {
    const dict: Record<string, string> = { a: 'A', constructor: 'C' };
    expect(ownValue(dict, 'a')).toBe('A');
    expect(ownValue(dict, 'constructor')).toBe('C');
    for (const k of ['toString', 'hasOwnProperty', 'valueOf', '__proto__', 'missing']) {
      expect(ownValue(dict, k)).toBeUndefined();
    }
  });
});
