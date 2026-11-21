// perf:assertJsonValue 先跑不拼路径串的快速遍历(合法输入——绝大多数——零路径分配;2.5MB/2 万对象
// 8.9ms → ~5.5ms),仅失败时再以带路径模式重跑生成错误消息。检查项 / 上限 / 抛错条件同源(同一遍历实现),
// 错误文案与旧实现逐字一致。
import { describe, expect, it, vi } from 'vitest';
import {
  assertJsonValue,
  MAX_JSON_KEY_LEN,
  MAX_JSON_OBJECT_KEYS,
} from '../assert-json-value';

const deep = (n: number): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};

const message = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return '<no throw>';
};

// 旧实现(每节点预拼路径)下捕获的错误文案,逐字锁定。
const INVALID: Array<[string, () => unknown, string]> = [
  ['顶层 NaN', () => NaN, 'non-finite number at $'],
  ['嵌套 Infinity', () => ({ a: [1, { b: Infinity }] }), 'non-finite number at $.a[1].b'],
  ['undefined 属性', () => ({ x: { y: undefined } }), 'non-JSON value (undefined) at $.x.y'],
  ['function', () => [() => 1], 'non-JSON value (function) at $[0]'],
  ['bigint', () => ({ n: 1n }), 'non-JSON value (bigint) at $.n'],
  ['symbol 值', () => ({ s: Symbol('x') }), 'non-JSON value (symbol) at $.s'],
  // eslint-disable-next-line no-sparse-arrays
  ['稀疏空洞', () => ({ k: [1, , 3] }), 'sparse array hole at $.k[1]'],
  ['数组过大', () => ({ k: new Array(1_000_001) }), 'array too large (1000001 > 1000000) at $.k'],
  ['非 plain 对象', () => ({ d: new Date(0) }), 'non-plain object at $.d'],
  ['symbol key', () => ({ o: { [Symbol('s')]: 1 } }), 'symbol key in object at $.o'],
  [
    'key 过长',
    () => ({ o: { ['k'.repeat(MAX_JSON_KEY_LEN + 1)]: 1 } }),
    `object key too long (${MAX_JSON_KEY_LEN + 1} > ${MAX_JSON_KEY_LEN}) at $.o`,
  ],
  [
    '非枚举属性',
    () => ({ o: Object.defineProperty({}, 'h', { value: 1, enumerable: false }) }),
    'non-enumerable own property in object at $.o',
  ],
  [
    'getter',
    () => ({ o: Object.defineProperty({}, 'g', { get: () => 1, enumerable: true }) }),
    'accessor (getter/setter) property in object at $.o',
  ],
  [
    'key 过多',
    () => {
      const o: Record<string, number> = {};
      for (let i = 0; i <= MAX_JSON_OBJECT_KEYS; i++) o[`k${i}`] = 0;
      return { o };
    },
    `object too many keys (${MAX_JSON_OBJECT_KEYS + 1} > ${MAX_JSON_OBJECT_KEYS}) at $.o`,
  ],
  ['嵌套过深', () => deep(257), `json nesting too deep at $${'[0]'.repeat(257)}`],
  ['第一个错误优先', () => ({ a: 1, b: NaN, c: undefined }), 'non-finite number at $.b'],
];

describe('assertJsonValue 快速路径(不预拼路径)', () => {
  it.each(INVALID)('非法输入 %s → 错误文案与旧实现逐字一致', (_name, make, expected) => {
    expect(message(() => assertJsonValue(make()))).toBe(expected);
  });

  it('自定义根路径仍体现在错误文案中', () => {
    expect(message(() => assertJsonValue({ a: [NaN] }, 'root'))).toBe('non-finite number at root.a[0]');
  });

  it('合法输入不生成任何路径串(根路径从不被插值)', () => {
    const toString = vi.fn(() => '$');
    const root = { toString } as unknown as string;
    const valid = {
      list: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `n${i}`, ok: true, tags: ['a', null] })),
      nested: deep(200),
    };
    assertJsonValue(valid, root);
    expect(toString).not.toHaveBeenCalled();
  });

  it('快速模式判非法但重跑未复现(Proxy 非确定)→ 仍 fail-closed 抛错', () => {
    let calls = 0;
    const flaky = new Proxy(
      {},
      { ownKeys: () => (calls++ === 0 ? [Symbol('s')] : []) },
    );
    expect(message(() => assertJsonValue(flaky))).toBe('non-JSON value at $');
  });

  it('非法输入才以带路径模式重跑生成消息', () => {
    const toString = vi.fn(() => 'R');
    const root = { toString } as unknown as string;
    expect(message(() => assertJsonValue({ a: [1, NaN] }, root))).toBe('non-finite number at R.a[1]');
    expect(toString).toHaveBeenCalled();
  });
});
