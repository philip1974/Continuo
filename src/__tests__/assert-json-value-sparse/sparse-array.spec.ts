// 边界(E183):assertJsonValue 数组分支须限 length + 拒 sparse 空洞。此前用 forEach(跳过空洞)→
// new Array(1e9) 稀疏巨数组秒过校验,JSON.stringify 生成超大 JSON OOM;空洞 stringify 成 null 落盘变形。
import { describe, it, expect } from 'vitest';
import {
  assertJsonValue,
  MAX_JSON_OBJECT_KEYS,
  MAX_JSON_KEY_LEN,
  MAX_JSON_STRING_LEN,
} from '../../../electron/shared/assert-json-value';

describe('assertJsonValue 数组边界 (E183)', () => {
  it('稀疏巨数组 new Array(1e9) → 抛(length 超上限,不进 stringify)', () => {
    expect(() => assertJsonValue(new Array(1_000_000_000))).toThrow(/too large/i);
  });

  it('稀疏空洞数组(含 hole)→ 抛 sparse hole(forEach 会漏检)', () => {
    const a = [1, 2, 3];
    delete a[1]; // 制造空洞
    expect(() => assertJsonValue(a)).toThrow(/sparse array hole/i);
    // eslint-disable-next-line no-sparse-arrays
    expect(() => assertJsonValue([1, , 3])).toThrow(/sparse array hole/i);
  });

  it('恰好上限内的稠密数组 → ok', () => {
    expect(() => assertJsonValue([1, 'a', true, null, { x: 1 }, [2, 3]])).not.toThrow();
  });

  it('数组元素仍递归校验(非 JSON 元素 → 抛)', () => {
    expect(() => assertJsonValue([1, Infinity])).toThrow(/non-finite/i);
    expect(() => assertJsonValue([{ a: undefined }])).toThrow(/non-JSON/i);
  });

  it('空数组 → ok', () => {
    expect(() => assertJsonValue([])).not.toThrow();
  });

  it('嵌套稀疏数组也被拒', () => {
    const inner = [0];
    delete inner[0];
    expect(() => assertJsonValue({ k: inner })).toThrow(/sparse array hole/i);
  });
});

// 边界(E184,E183 对象对偶):object 分支 key 数量上限 + 一次 Reflect.ownKeys(替代多次全量物化)。
describe('assertJsonValue 对象边界 (E184)', () => {
  it('object key 数超 MAX_JSON_OBJECT_KEYS → 抛 too many keys', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i <= MAX_JSON_OBJECT_KEYS; i++) big[`k${i}`] = 1;
    expect(() => assertJsonValue(big)).toThrow(/too many keys/i);
  });

  it('symbol key → 抛(经 Reflect.ownKeys 单循环判别,E140 保持)', () => {
    expect(() => assertJsonValue({ [Symbol('s')]: 1 })).toThrow(/symbol key/i);
  });

  it('非枚举自有属性 → 抛(E140 保持)', () => {
    const o: Record<string, unknown> = {};
    Object.defineProperty(o, 'hidden', { value: 1, enumerable: false });
    expect(() => assertJsonValue(o)).toThrow(/non-enumerable/i);
  });

  it('正常对象(含嵌套)+ Object.create(null) → ok', () => {
    expect(() => assertJsonValue({ a: 1, b: { c: 'x' } })).not.toThrow();
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.k = 2;
    expect(() => assertJsonValue(nullProto)).not.toThrow();
  });

  it('对象值仍递归校验(非 JSON 值 → 抛)', () => {
    expect(() => assertJsonValue({ a: Infinity })).toThrow(/non-finite/i);
    expect(() => assertJsonValue({ a: () => 1 })).toThrow(/non-JSON/i);
  });

  // 边界(E254):单个 key 长度上限,超长直接抛(不推迟到 JSON.stringify 字节兜底制造巨大分配)。
  it('E254 单个 key 长度超 MAX_JSON_KEY_LEN → 抛 key too long(错误消息不含 key 本身)', () => {
    const longKey = 'x'.repeat(MAX_JSON_KEY_LEN + 1);
    const err = (() => {
      try {
        assertJsonValue({ [longKey]: 1 });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toMatch(/key too long/i);
    // 错误消息只含长度数字,不拼超长 key(防错误串本身放大)
    expect(err!.message.length).toBeLessThan(200);
    expect(err!.message).not.toContain(longKey);
  });

  it('E254 恰好 MAX_JSON_KEY_LEN 的 key → ok', () => {
    expect(() =>
      assertJsonValue({ ['k'.repeat(MAX_JSON_KEY_LEN)]: 1 }),
    ).not.toThrow();
  });
});

// 边界(E285,E254 字符串值对偶):单个 string **值**长度上限 —— 超大字符串值在 stringify(OOM 点)
// 之前 fail-fast,不推迟到「stringify 后按字节 cap」(那时巨字符串已物化)。
describe('assertJsonValue 字符串值边界 (E285)', () => {
  it('顶层字符串值超 MAX_JSON_STRING_LEN → 抛 string too long(错误消息不含字符串本身)', () => {
    const huge = 'x'.repeat(MAX_JSON_STRING_LEN + 1);
    const err = (() => {
      try {
        assertJsonValue(huge);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toMatch(/string too long/i);
    // 错误消息只含长度数字,不拼超大字符串(防错误串本身放大)
    expect(err!.message.length).toBeLessThan(200);
    expect(err!.message).not.toContain(huge);
  });

  it('对象/数组里的超大字符串值也被递归拒(stringify 前 fail-fast)', () => {
    const huge = 'x'.repeat(MAX_JSON_STRING_LEN + 1);
    expect(() => assertJsonValue({ value: huge })).toThrow(/string too long/i);
    expect(() => assertJsonValue([huge])).toThrow(/string too long/i);
    expect(() => assertJsonValue({ a: { b: [huge] } })).toThrow(
      /string too long/i,
    );
  });

  it('恰好 MAX_JSON_STRING_LEN 的字符串值 → ok(边界包含)', () => {
    expect(() =>
      assertJsonValue({ v: 'x'.repeat(MAX_JSON_STRING_LEN) }),
    ).not.toThrow();
  });

  it('普通短字符串 → 仍 ok(回归,行为不变)', () => {
    expect(() => assertJsonValue('hello')).not.toThrow();
    expect(() => assertJsonValue({ a: 'short', b: ['x', 'y'] })).not.toThrow();
  });
});

// 边界(E200,E103/E136 数据完整性族):accessor(getter/setter)属性 → 抛。否则校验读 obj[k] 调
// getter 一次、调用方 JSON.stringify 再调一次,getter 可两次返回不同值 → 校验↔落盘不一致(TOCTOU)。
describe('assertJsonValue accessor 属性 (E200)', () => {
  it('enumerable getter 属性 → 抛 accessor(即使 getter 当前返 JSON-safe 值)', () => {
    const o = {};
    Object.defineProperty(o, 'x', {
      enumerable: true,
      configurable: true,
      get() {
        return 1; // 校验时看似合法,但 stringify 会再调一次
      },
    });
    expect(() => assertJsonValue(o)).toThrow(/accessor/i);
  });

  it('getter 两次返回不同值(校验小、stringify 大)→ 校验阶段即拒(不读 getter 返回值)', () => {
    let n = 0;
    const o = {};
    Object.defineProperty(o, 'evil', {
      enumerable: true,
      configurable: true,
      get() {
        n += 1;
        return n === 1 ? 'small' : 'x'.repeat(1_000_000);
      },
    });
    expect(() => assertJsonValue(o)).toThrow(/accessor/i);
    // 关键:校验走 desc.value(accessor 无 value)→ 直接拒,从不执行 getter。
    expect(n).toBe(0);
  });

  it('setter-only 属性 → 抛 accessor', () => {
    const o = {};
    Object.defineProperty(o, 'w', {
      enumerable: true,
      configurable: true,
      set() {
        /* noop */
      },
    });
    expect(() => assertJsonValue(o)).toThrow(/accessor/i);
  });

  it('普通 data 属性(含嵌套)→ 仍 ok(回归,行为不变)', () => {
    expect(() => assertJsonValue({ a: 1, b: { c: 'x' } })).not.toThrow();
  });
});
