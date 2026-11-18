// 查表 / 写表 helper 的单元规范(见 ./README.md)。
import { describe, it, expect } from 'vitest';
import { ownValue, setOwnValue } from '../../../electron/shared/own-value';

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

describe('setOwnValue', () => {
  it('`__proto__` 键写成自有数据属性,原型不变', () => {
    const dict: Record<string, unknown> = {};
    setOwnValue(dict, '__proto__', { x: 1 });
    setOwnValue(dict, 'b', 2);
    expect(Object.getPrototypeOf(dict)).toBe(Object.prototype);
    expect(ownValue(dict, '__proto__')).toEqual({ x: 1 });
    expect(JSON.stringify(dict)).toBe('{"__proto__":{"x":1},"b":2}');
  });
});
