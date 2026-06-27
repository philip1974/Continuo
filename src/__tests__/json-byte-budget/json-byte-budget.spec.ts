// 边界(E286,E283/E285「stringify 前 fail-fast」族 —— 字节预算维度):序列化字节下界预检,在
// JSON.stringify 物化巨字符串之前对「形态合法但很多中等元素」的值 fail-fast,不改变 accept/reject 判定。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { jsonByteLowerBoundExceeds } from '../../../electron/shared/json-byte-budget';
import { utf8ByteLength } from '../../../electron/shared/utf8-byte-length';
import { isInvokeResultAdmissible } from '../../../electron/shared/plugin-mcp-schemas';
import {
  sanitizeReadLayout,
  MAX_LAYOUT_BYTES,
} from '../../../electron/main/lib/layout-read-guard';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

describe('jsonByteLowerBoundExceeds 下界正确性 (E286)', () => {
  // 无转义的 ASCII 值,下界 == 真实字节,可与 JSON.stringify 精确对齐。
  const samples: unknown[] = [
    null,
    true,
    false,
    0,
    -12345,
    1.5,
    'hello',
    '',
    [1, 2, 3],
    { a: 1, b: 'two', c: [true, null] },
    { nested: { deep: { arr: ['x', 'y', 'z'] } } },
    [],
    {},
    [{ k: 'v' }, { k: 'w' }],
  ];

  it('无转义 ASCII 值:下界判定与真实序列化字节判定逐一一致(多个上限)', () => {
    for (const v of samples) {
      const realBytes = utf8ByteLength(JSON.stringify(v) ?? '');
      for (const L of [0, 1, 5, 10, 20, 50, 100, realBytes - 1, realBytes]) {
        expect(jsonByteLowerBoundExceeds(v, L)).toBe(realBytes > L);
      }
    }
  });

  it('下界永不高估:返回 true ⇒ 真实序列化字节确实 > limit(含含转义/CJK 字符串)', () => {
    const tricky: unknown[] = [
      'a"b\\c\n\t' + 'x'.repeat(50), // 转义使真实 > 下界
      '中文'.repeat(40), // CJK 3 bytes/字
      { msg: '"quotes"\\and\\stuff', list: ['中', '文', 'emoji😀'] },
    ];
    for (const v of tricky) {
      for (const L of [0, 5, 20, 50, 80]) {
        if (jsonByteLowerBoundExceeds(v, L)) {
          expect(utf8ByteLength(JSON.stringify(v))).toBeGreaterThan(L);
        }
      }
    }
  });

  it('永不误伤:序列化字节 ≤ limit 的值(即便含转义)→ false', () => {
    const v = { a: 'a"b\\c', b: '中文', c: [1, 2, 3] };
    const realBytes = utf8ByteLength(JSON.stringify(v));
    expect(jsonByteLowerBoundExceeds(v, realBytes)).toBe(false);
    expect(jsonByteLowerBoundExceeds(v, realBytes + 1000)).toBe(false);
  });

  it('fail-fast:形态合法但很多中等元素 → 提前判超限(小上限,免大分配)', () => {
    const arr = Array.from({ length: 50 }, () => 'mediumstring'); // 远超 limit=100
    expect(jsonByteLowerBoundExceeds(arr, 100)).toBe(true);
    const obj: Record<string, string> = {};
    for (let i = 0; i < 50; i++) obj[`key${i}`] = 'val';
    expect(jsonByteLowerBoundExceeds(obj, 100)).toBe(true);
  });
});

describe('jsonByteLowerBoundExceeds 任意输入安全 (E288,host 通用边界无前置 assertJsonValue)', () => {
  it('绝不抛错:undefined/function/symbol/bigint/非有限数 → 返回 boolean(不 throw)', () => {
    const sym = Symbol('s');
    const cases: unknown[] = [
      undefined,
      () => 1,
      sym,
      10n,
      Infinity,
      -Infinity,
      NaN,
      { a: undefined, b: () => 1, c: sym },
      [undefined, () => 1, sym],
      { big: 1n },
    ];
    for (const v of cases) {
      expect(typeof jsonByteLowerBoundExceeds(v, 1024)).toBe('boolean');
      expect(jsonByteLowerBoundExceeds(v, 1024)).toBe(false); // 都很小 → 不超限
    }
  });

  it('复刻 JSON.stringify 省略/强转语义,下界对这些可序列化用例精确(true ⇔ real > limit)', () => {
    // 这些用例下界 == 真实字节(省略对象成员 / 数组里 →null / 非有限数 →null),可逐一与真实对齐。
    const exact: unknown[] = [
      { a: undefined, b: 1 }, // '{"b":1}'
      [1, undefined], // '[1,null]'
      { n: Infinity }, // '{"n":null}'
      { a: 1, b: undefined, c: 2 }, // '{"a":1,"c":2}'
      [NaN, -Infinity], // '[null,null]'
    ];
    for (const v of exact) {
      const realBytes = utf8ByteLength(JSON.stringify(v) ?? '');
      for (const L of [0, 1, realBytes - 1, realBytes, realBytes + 5]) {
        expect(jsonByteLowerBoundExceeds(v, L)).toBe(realBytes > L);
      }
    }
  });

  it('非 JSON-safe 但很多中等元素 → 仍 fail-fast(数组里 →null 计 4)', () => {
    const arr = Array.from({ length: 60 }, () => undefined); // 每元素 "null"=4 → ~240+ > 100
    expect(jsonByteLowerBoundExceeds(arr, 100)).toBe(true);
  });

  // 边界(E301,E300 同款 for...in + hasOwnProperty):object 分支只计自有可枚举 key,继承属性不计
  //(与 Object.keys / JSON.stringify 一致)。neutralize 敏感:漏 hasOwnProperty 则继承 key 被计入抬高下界。
  it('E301 继承可枚举属性不计入(与 JSON.stringify 一致)', () => {
    const proto = { inheritedKey: 'should-not-count-in-bytes' };
    const o = Object.create(proto) as Record<string, unknown>;
    o.own = 'x';
    const realBytes = utf8ByteLength(JSON.stringify(o)); // '{"own":"x"}' = 11(不含继承 key)
    for (const L of [0, realBytes - 1, realBytes]) {
      expect(jsonByteLowerBoundExceeds(o, L)).toBe(realBytes > L);
    }
  });
});

describe('isInvokeResultAdmissible 字节预算 fail-fast (E286,codex cycle-57 报告点)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('超 RESULT_BYTES_MAX 的「很多中等元素」result → 拒,且在 stringify **之前** fail-fast(JSON.stringify 不被调用)', () => {
    // 11 × 1MiB 字符串 → 字节下界 ~11MiB > RESULT_BYTES_MAX(10MiB),但每段 < E285 单字符串值上限。
    const chunk = 'x'.repeat(1024 * 1024);
    const huge = Array.from({ length: 11 }, () => chunk);
    const spy = vi.spyOn(JSON, 'stringify');
    expect(isInvokeResultAdmissible(huge)).toBe(false);
    // 关键(neutralize 敏感):去掉字节预算预检后,会落到下游 JSON.stringify 才拒 → 此断言失败。
    expect(spy).not.toHaveBeenCalled();
  });

  it('上限内的正常 result → 仍 admissible(回归,精确裁决不变)', () => {
    expect(isInvokeResultAdmissible({ ok: true, items: [1, 2, 3] })).toBe(true);
    expect(isInvokeResultAdmissible('short')).toBe(true);
    expect(isInvokeResultAdmissible(undefined)).toBe(true);
  });
});

describe('sanitizeReadLayout 字节预算 fail-fast (E286,cycle-58 layout 兄弟入口)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('超 MAX_LAYOUT_BYTES 的「很多中等元素」layout → 返 null,且 stringify 之前 fail-fast(JSON.stringify 不被调用)', () => {
    const chunk = 'x'.repeat(256 * 1024); // 256KiB
    const count = Math.ceil(MAX_LAYOUT_BYTES / chunk.length) + 4; // 字节下界 > MAX_LAYOUT_BYTES
    const huge = { panels: Array.from({ length: count }, () => chunk) };
    const spy = vi.spyOn(JSON, 'stringify');
    expect(sanitizeReadLayout(huge)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('上限内正常 layout → 原样返回(回归)', () => {
    const layout = { grid: { root: { type: 'branch' } }, panels: {} };
    expect(sanitizeReadLayout(layout)).toEqual(layout);
    expect(sanitizeReadLayout(null)).toBeNull();
  });
});

describe('E286 家族接线守卫:全部 stringify+字节cap 入口在 stringify 前调用下界预检', () => {
  const sites = [
    'electron/shared/plugin-mcp-schemas.ts',
    'src/plugins/PluginDataStore.ts',
    'electron/main/services/plugin-data-store.service.ts',
    'electron/main/ipc.ts',
    'electron/main/lib/layout-read-guard.ts',
    'electron/main/services/mcp-host.service.ts',
    'src/plugins/registries/PluginMcpRegistry.ts',
  ];
  it.each(sites)('%s 引用 jsonByteLowerBoundExceeds', (rel) => {
    const src = readFileSync(resolve(repoRoot, rel), 'utf-8');
    expect(src).toContain('jsonByteLowerBoundExceeds');
  });
});
