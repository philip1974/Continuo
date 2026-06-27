// @vitest-environment jsdom
// 边界(E22):readRecord 此前「是 object 就强转」,不校验 value/key/条目数。畸形/篡改 localStorage
// (如 keybindings overrides 混入非字符串)会被读进内存,下游 .toLowerCase() 崩溃。opts 提供 value
// 守卫 + 上限,非法 value 丢弃、超长 key 跳过、超条目数截断;不传 opts 保持旧行为。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readRecord, writeRecord } from '@/plugins/storage/local-storage-record';

const KEY = 'test.record';

beforeEach(() => {
  globalThis.localStorage.clear();
});

// 边界(E198,E197/E176/E189/E192 有界迭代族):readRecord constrained 路径单次 for...in 惰性遍历,
// 边计数边过滤,达 maxEntries 立即 break,不先 Object.entries 把所有键值对全量物化。
describe('E198 · readRecord constrained 有界单次遍历', () => {
  it('constrained 路径不调用 Object.entries(单次 for...in,不全量物化)', () => {
    const data: Record<string, string> = {};
    for (let i = 0; i < 50; i++) data[`k${i}`] = 'v';
    globalThis.localStorage.setItem(KEY, JSON.stringify(data));
    const entriesSpy = vi.spyOn(Object, 'entries');
    const r = readRecord<string>(KEY, { maxEntries: 10 });
    expect(Object.keys(r)).toHaveLength(10);
    expect(entriesSpy).not.toHaveBeenCalled();
    entriesSpy.mockRestore();
  });

  it('maxEntries 截断保留插入序前 N 项(回归)', () => {
    const data: Record<string, string> = {};
    for (let i = 0; i < 20; i++) data[`k${i}`] = `v${i}`;
    globalThis.localStorage.setItem(KEY, JSON.stringify(data));
    const r = readRecord<string>(KEY, { maxEntries: 3 });
    expect(Object.keys(r)).toEqual(['k0', 'k1', 'k2']);
  });

  it('skip(超长 key/非法 value)不计入 maxEntries,凑满合法项才 break', () => {
    globalThis.localStorage.setItem(
      KEY,
      JSON.stringify({ kk: 'a', bad: 123, ok2: 'b', ok3: 'c' }),
    );
    const r = readRecord<string>(KEY, {
      maxEntries: 2,
      valueGuard: (v): v is string => typeof v === 'string',
    });
    // bad(非字符串)跳过不计数 → 收满 2 个合法:kk, ok2
    expect(r).toEqual({ kk: 'a', ok2: 'b' });
  });
});

describe('readRecord value guard / limits (E22)', () => {
  it('不传 opts → 旧行为:object 直接强转(含非预期 value)', () => {
    globalThis.localStorage.setItem(KEY, JSON.stringify({ a: 'x', b: 123 }));
    expect(readRecord(KEY)).toEqual({ a: 'x', b: 123 });
  });

  it('valueGuard 过滤非字符串 value(keybindings 场景)', () => {
    globalThis.localStorage.setItem(
      KEY,
      JSON.stringify({ ok: 'mod+s', bad: 123, obj: { x: 1 }, nul: null }),
    );
    const r = readRecord<string>(KEY, {
      valueGuard: (v): v is string => typeof v === 'string',
    });
    expect(r).toEqual({ ok: 'mod+s' }); // 非字符串项全丢弃
  });

  it('valueGuard 含长度限制 → 超长 value 丢弃', () => {
    globalThis.localStorage.setItem(
      KEY,
      JSON.stringify({ short: 'a', long: 'x'.repeat(257) }),
    );
    const r = readRecord<string>(KEY, {
      valueGuard: (v): v is string => typeof v === 'string' && v.length <= 256,
    });
    expect(r).toEqual({ short: 'a' });
  });

  it('maxKeyLength → 超长 key 跳过', () => {
    const longKey = 'k'.repeat(300);
    globalThis.localStorage.setItem(
      KEY,
      JSON.stringify({ ok: 'v', [longKey]: 'v2' }),
    );
    const r = readRecord<string>(KEY, { maxKeyLength: 256 });
    expect(Object.keys(r)).toEqual(['ok']);
  });

  it('maxEntries → 超条目数截断', () => {
    const data: Record<string, string> = {};
    for (let i = 0; i < 50; i++) data[`k${i}`] = 'v';
    globalThis.localStorage.setItem(KEY, JSON.stringify(data));
    const r = readRecord<string>(KEY, { maxEntries: 10 });
    expect(Object.keys(r)).toHaveLength(10);
  });

  it('settings 场景:原语守卫保留 string/number/boolean,丢对象/数组', () => {
    globalThis.localStorage.setItem(
      KEY,
      JSON.stringify({ s: 'x', n: 14, b: true, o: { a: 1 }, arr: [1] }),
    );
    const r = readRecord<string | number | boolean>(KEY, {
      valueGuard: (v): v is string | number | boolean =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
    });
    expect(r).toEqual({ s: 'x', n: 14, b: true });
  });

  it('非对象 / 数组 / 损坏 JSON → {}', () => {
    globalThis.localStorage.setItem(KEY, JSON.stringify([1, 2]));
    expect(readRecord(KEY, { maxEntries: 5 })).toEqual({});
    globalThis.localStorage.setItem(KEY, '{not json');
    expect(readRecord(KEY, { maxEntries: 5 })).toEqual({});
  });
});

// 边界(E70,E64/E67/E68 解析前上限族):E22 守卫都在 JSON.parse 后,挡不住解析前成本。
// readRecord 先按原始串长度 cap 拦,超限直接返 {}(不 JSON.parse / 不枚举)。
describe('readRecord 原始串长度上限 (E70)', () => {
  it('maxRawLength 显式上限:超限 → {}(解析前拦),未超 → 正常解析', () => {
    // 合法 JSON,但原始串超 maxRawLength → 解析前拦截返 {}
    const big = JSON.stringify({ a: 'x'.repeat(200) });
    globalThis.localStorage.setItem(KEY, big);
    expect(readRecord(KEY, { maxRawLength: 50 })).toEqual({});
    // 同样合法 JSON,放宽上限 → 正常解析
    expect(readRecord(KEY, { maxRawLength: 1024 })).toEqual({ a: 'x'.repeat(200) });
  });

  it('默认 1MiB 上限对未传 opts 调用方也生效:超 1MiB → {}', () => {
    // 构造 >1MiB 的合法 JSON 字符串;无 cap 时会被解析,有默认 cap → {}
    const huge = JSON.stringify({ k: 'y'.repeat(1024 * 1024 + 10) });
    globalThis.localStorage.setItem(KEY, huge);
    expect(readRecord(KEY)).toEqual({}); // 默认上限拦截,不强转超大对象
  });
});

// 边界(E260,写读 cap 对称 / E242/E246/E247/E249/E252 同族):写端总串长须 ≤ 读端 raw cap,否则写出
// 读端会整表丢弃的超大记录 = 本会话成功、下次启动 readRecord 返 {} = 静默丢全表。
describe('writeRecord 写读 cap 对称 (E260)', () => {
  it('正常小记录 → ok 且落盘可被 readRecord 读回', () => {
    expect(writeRecord(KEY, { a: 'x', b: 'y' })).toBe('ok');
    expect(readRecord(KEY)).toEqual({ a: 'x', b: 'y' });
  });

  it('写入内容与现有 raw 完全相同 → ok 且不重复 setItem', () => {
    globalThis.localStorage.setItem(KEY, JSON.stringify({ a: 'x', b: 'y' }));
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    try {
      expect(writeRecord(KEY, { a: 'x', b: 'y' })).toBe('ok');
      expect(setItemSpy).not.toHaveBeenCalled();
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('超 maxRawLength → too-large 且拒写(保留上次有效值)', () => {
    expect(writeRecord(KEY, { keep: 'prev' })).toBe('ok'); // 先写有效值
    const r = writeRecord(KEY, { big: 'x'.repeat(200) }, { maxRawLength: 50 });
    expect(r).toBe('too-large');
    // 拒写:localStorage 仍是上次有效值,未被超大记录覆盖
    expect(globalThis.localStorage.getItem(KEY)).toBe(
      JSON.stringify({ keep: 'prev' }),
    );
  });

  it('超默认 1MiB → too-large(与读端默认 cap 对齐)', () => {
    const r = writeRecord(KEY, { k: 'y'.repeat(1024 * 1024 + 10) });
    expect(r).toBe('too-large');
    expect(globalThis.localStorage.getItem(KEY)).toBeNull(); // 未写入
  });

  it('写读对称:writeRecord 接受的记录 readRecord 必能读回(无写成功读丢失)', () => {
    // 略小于 1MiB → 写成功 → 读回不为 {}(若写端松于读端,这种刚好会被读端整表丢弃)
    const payload = { k: 'z'.repeat(1024 * 1024 - 100) };
    expect(writeRecord(KEY, payload)).toBe('ok');
    expect(readRecord<string>(KEY)).toEqual(payload); // 写成功 ⇒ 读得回(对称)
  });

  // 边界(E309,E286 字节预算族 / .length 变体):超 maxRawLength → too-large,且 .length 下界 fail-fast
  // 在 JSON.stringify 之前(不先物化巨串)。
  it('E309 超 maxRawLength → too-large 且 JSON.stringify 不被调用(stringify 前 fail-fast)', () => {
    const spy = vi.spyOn(JSON, 'stringify');
    const r = writeRecord(KEY, { big: 'x'.repeat(200) }, { maxRawLength: 50 });
    expect(r).toBe('too-large');
    // neutralize 敏感:去 .length 下界预检则落到 JSON.stringify 才按 .length cap 拒。
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // 边界(E309):cap 是 UTF-16 .length(非 UTF-8 字节)—— CJK 记录按 .length 计,不按字节误拒。
  it('E309 CJK 记录 .length 在上限内 → ok(不按 UTF-8 字节误拒)', () => {
    // '中'×40:.length 40(UTF-8 ~120 字节)。serialized={"a":"中×40"} .length≈48 ≤ 100 → ok。
    const r = writeRecord(KEY, { a: '中'.repeat(40) }, { maxRawLength: 100 });
    expect(r).toBe('ok');
  });
});
