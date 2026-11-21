// 边界(E255/E256/E257 同族):shared boundedObjectAdmissible —— 三入口共享的单一逻辑来源。
import { describe, it, expect } from 'vitest';
import {
  boundedObjectAdmissible,
  boundedValueDeepAdmissible,
  MAX_BOUNDED_OBJECT_KEYS,
  MAX_BOUNDED_OBJECT_KEY_LEN,
  MAX_BOUNDED_DEPTH,
  MAX_BOUNDED_ARRAY_LEN,
} from '../../../electron/shared/bounded-input';

describe('boundedObjectAdmissible(E255/E256/E257 shared)', () => {
  it('非 plain object(string/number/array/null/undefined)→ 放行', () => {
    expect(boundedObjectAdmissible('s')).toEqual({ ok: true });
    expect(boundedObjectAdmissible(42)).toEqual({ ok: true });
    expect(boundedObjectAdmissible(null)).toEqual({ ok: true });
    expect(boundedObjectAdmissible(undefined)).toEqual({ ok: true });
    expect(boundedObjectAdmissible([1, 2, 3])).toEqual({ ok: true });
  });

  it('正常 object → ok', () => {
    expect(boundedObjectAdmissible({ a: 1, b: 'x' })).toEqual({ ok: true });
  });

  it('恰好上限内的 key 数 → ok', () => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < MAX_BOUNDED_OBJECT_KEYS; i += 1) o[`k${i}`] = 1;
    expect(boundedObjectAdmissible(o)).toEqual({ ok: true });
  });

  it('key 数超上限 → reason too-many-keys', () => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_BOUNDED_OBJECT_KEYS; i += 1) o[`k${i}`] = 1;
    expect(boundedObjectAdmissible(o)).toEqual({
      ok: false,
      reason: 'too-many-keys',
    });
  });

  it('单 key 超长 → reason key-too-long', () => {
    expect(
      boundedObjectAdmissible({ ['x'.repeat(MAX_BOUNDED_OBJECT_KEY_LEN + 1)]: 1 }),
    ).toEqual({ ok: false, reason: 'key-too-long' });
  });

  it('恰好 KEY_LEN 的 key → ok', () => {
    expect(
      boundedObjectAdmissible({ ['x'.repeat(MAX_BOUNDED_OBJECT_KEY_LEN)]: 1 }),
    ).toEqual({ ok: true });
  });

  it('顶层只检顶层 key —— 嵌套海量 key 不被顶层 helper 拦(故需 deep 变体)', () => {
    const inner: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_BOUNDED_OBJECT_KEYS; i += 1) inner[`k${i}`] = 1;
    expect(boundedObjectAdmissible({ outer: inner })).toEqual({ ok: true });
  });

  // 边界(E300,for...in + hasOwnProperty 重构):只数**自有**可枚举 key,继承可枚举属性不计
  //(保持 Object.keys 语义)。neutralize 敏感:漏 hasOwnProperty 则 for...in 把海量继承 key 误计 → too-many-keys。
  it('E300 继承的海量可枚举属性不计入(只数自有 key)', () => {
    const proto: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_BOUNDED_OBJECT_KEYS; i += 1) proto[`inh${i}`] = 1;
    const o = Object.create(proto) as Record<string, unknown>;
    o.own = 1; // 仅 1 个自有 key
    expect(boundedObjectAdmissible(o)).toEqual({ ok: true });
  });
});

describe('boundedValueDeepAdmissible(E259 递归)', () => {
  it('原始值/小对象/小数组 → ok', () => {
    expect(boundedValueDeepAdmissible('s')).toEqual({ ok: true });
    expect(boundedValueDeepAdmissible(42)).toEqual({ ok: true });
    expect(boundedValueDeepAdmissible(null)).toEqual({ ok: true });
    expect(boundedValueDeepAdmissible({ a: { b: { c: [1, 2, 3] } } })).toEqual({
      ok: true,
    });
  });

  it('嵌套对象海量 key → too-many-keys(顶层 helper 漏,deep 拦)', () => {
    const inner: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_BOUNDED_OBJECT_KEYS; i += 1) inner[`k${i}`] = 1;
    expect(boundedValueDeepAdmissible({ outer: inner })).toEqual({
      ok: false,
      reason: 'too-many-keys',
    });
  });

  it('嵌套超长 key → key-too-long', () => {
    expect(
      boundedValueDeepAdmissible({
        outer: { ['x'.repeat(MAX_BOUNDED_OBJECT_KEY_LEN + 1)]: 1 },
      }),
    ).toEqual({ ok: false, reason: 'key-too-long' });
  });

  it('数组长度超 MAX_BOUNDED_ARRAY_LEN → array-too-long(不迭代稀疏)', () => {
    expect(
      boundedValueDeepAdmissible({ items: new Array(MAX_BOUNDED_ARRAY_LEN + 1) }),
    ).toEqual({ ok: false, reason: 'array-too-long' });
  });

  it('嵌套深度超 MAX_BOUNDED_DEPTH → too-deep', () => {
    let nested: Record<string, unknown> = {};
    const root = nested;
    for (let i = 0; i < MAX_BOUNDED_DEPTH + 5; i += 1) {
      const child: Record<string, unknown> = {};
      nested['a'] = child;
      nested = child;
    }
    expect(boundedValueDeepAdmissible(root)).toEqual({
      ok: false,
      reason: 'too-deep',
    });
  });

  it('恰好深度 MAX_BOUNDED_DEPTH → ok', () => {
    let nested: Record<string, unknown> = {};
    const root = nested;
    // 构造深度恰好 MAX_BOUNDED_DEPTH(根在 depth 0)
    for (let i = 0; i < MAX_BOUNDED_DEPTH; i += 1) {
      const child: Record<string, unknown> = {};
      nested['a'] = child;
      nested = child;
    }
    expect(boundedValueDeepAdmissible(root)).toEqual({ ok: true });
  });

  it('数组元素递归校验(元素内嵌套海量 key → 拦)', () => {
    const inner: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_BOUNDED_OBJECT_KEYS; i += 1) inner[`k${i}`] = 1;
    expect(boundedValueDeepAdmissible([{ ok: 1 }, inner])).toEqual({
      ok: false,
      reason: 'too-many-keys',
    });
  });

  // 边界(E300):deep 变体同样只数自有 key,继承可枚举属性不计。
  it('E300 deep 变体继承可枚举属性不计入(只数自有 key)', () => {
    const proto: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_BOUNDED_OBJECT_KEYS; i += 1) proto[`inh${i}`] = 1;
    const o = Object.create(proto) as Record<string, unknown>;
    o.own = 1;
    expect(boundedValueDeepAdmissible(o)).toEqual({ ok: true });
  });
});
