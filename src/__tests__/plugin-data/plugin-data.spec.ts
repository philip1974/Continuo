import { describe, it, expect, vi } from 'vitest';
import { Plugin } from '../../plugins/Plugin';
import { InMemoryDataStore } from '../../plugins/PluginDataStore';
import { createTestApp } from '../../plugins/test-utils';
import type { PluginManifest } from '../../plugins/types';
import {
  utf8ByteLength,
  utf8BytesExceed,
} from '../../../electron/shared/utf8-byte-length';

// 边界(E125,E124 同族):字节上限须按真实 UTF-8 字节,而非 String.length(UTF-16 code unit)。
// 共享 helper 被 fs:write / plugin-fs / scoped-app / plugin-data / layout 等所有 *_BYTES 字符串入口复用。
describe('utf8 byte length (E125)', () => {
  it('ASCII:byteLength === length', () => {
    expect(utf8ByteLength('a'.repeat(100))).toBe(100);
  });
  it('CJK:每字 3 字节(byteLength > length)', () => {
    expect(utf8ByteLength('中'.repeat(50))).toBe(150); // length=50
  });
  it('emoji:astral 4 字节 / 2 code unit', () => {
    expect(utf8ByteLength('😀')).toBe(4); // '😀'.length === 2
  });
  it('utf8BytesExceed 按真实字节判超限(.length 会误放行)', () => {
    // '中'×50:byteLength=150,length=50。max=100:字节超限应 true(旧 .length=50≤100 会放行)。
    expect(utf8BytesExceed('中'.repeat(50), 100)).toBe(true);
    expect(utf8BytesExceed('中'.repeat(50), 200)).toBe(false);
    expect(utf8BytesExceed('a'.repeat(100), 100)).toBe(false);
    expect(utf8BytesExceed('a'.repeat(101), 100)).toBe(true);
    expect(utf8BytesExceed('😀', 3)).toBe(true); // 4 > 3
  });

  // 边界(E126):lone surrogate(不成对高/低代理)→ TextEncoder 编码为 U+FFFD(3 bytes),不消费
  // 下一字符。旧实现对任意高代理 +4/无条件跳过 → 对 '\uD800中'(真 6 bytes)undercount 成 4,绕过上限。
  it('E126 lone surrogate 与 TextEncoder 字节数完全一致', () => {
    const te = new TextEncoder();
    const cases = [
      '\uD800中', // lone 高代理 + CJK:真 6
      '😀', // 合法 pair:4
      '\uDC00', // lone 低代理:3
      '\uD800', // lone 高代理:3
      '中', // 3
      '\uD800\uD800a', // 两个 lone 高代理 + a:7
      '😀bar', // pair + ascii
      'aΩ中😀\uD800z', // 混合
    ];
    for (const s of cases) {
      expect(utf8ByteLength(s)).toBe(te.encode(s).byteLength);
    }
  });

  it('E126 lone 高代理 + 多字节绕过上限被拦', () => {
    // '\uD800中' 真 6 bytes;max=5 应判超限(旧实现算 4 ≤ 5 会误放行)。
    expect(utf8BytesExceed('\uD800中', 5)).toBe(true);
    expect(utf8BytesExceed('\uD800中', 6)).toBe(false);
  });
});

const manifest: PluginManifest = {
  id: 'test.data',
  name: 'Data',
  version: '0.1.0',
};

describe('InMemoryDataStore', () => {
  it('read 未写过的 id → null', async () => {
    const ds = new InMemoryDataStore();
    expect(await ds.read('foo')).toBeNull();
  });

  it('write + read 往返', async () => {
    const ds = new InMemoryDataStore();
    await ds.write('foo', { x: 1 });
    expect(await ds.read('foo')).toEqual({ x: 1 });
  });

  it('write 不同 id 互不干扰', async () => {
    const ds = new InMemoryDataStore();
    await ds.write('a', 1);
    await ds.write('b', 2);
    expect(await ds.read('a')).toBe(1);
    expect(await ds.read('b')).toBe(2);
  });

  it('write 同 id 覆盖', async () => {
    const ds = new InMemoryDataStore();
    await ds.write('k', 'v1');
    await ds.write('k', 'v2');
    expect(await ds.read('k')).toBe('v2');
  });

  // 边界(E43):write 大小上限与 IPC 实现对齐(行为保持),超限抛、不写入。
  // 用多段子上限字符串累加超 16MiB 字节(每段 < MAX_JSON_STRING_LEN,避开 E285 单字符串值上限),
  // 确保命中的是序列化字节 cap(/too large/)而非 E285 单值长度 cap(/string too long/)。
  it('E43 超过大小上限 → 抛,不写入', async () => {
    const ds = new InMemoryDataStore();
    const huge = Array.from({ length: 17 }, () => 'x'.repeat(1024 * 1024));
    await expect(ds.write('k', huge)).rejects.toThrow(/too large/i);
    expect(await ds.read('k')).toBeNull();
  });

  // 边界(E103):JSON.stringify 静默改写 NaN/Infinity→null、丢 undefined → write 须 assertJsonValue
  // 递归拒非 JSON 安全值,不静默持久化损坏(拒绝后不写)。
  it('E103 写 Infinity → 抛(非有限数),不写入', async () => {
    const ds = new InMemoryDataStore();
    await expect(ds.write('k', { x: Infinity })).rejects.toThrow(
      /non-finite|non-JSON/i,
    );
    expect(await ds.read('k')).toBeNull();
  });

  it('E103 写 NaN → 抛,不写入', async () => {
    const ds = new InMemoryDataStore();
    await expect(ds.write('k', { x: NaN })).rejects.toThrow();
    expect(await ds.read('k')).toBeNull();
  });

  it('E103 写含 undefined 属性 → 抛(JSON 会静默丢弃),不写入', async () => {
    const ds = new InMemoryDataStore();
    await expect(ds.write('k', { a: 1, b: undefined })).rejects.toThrow();
    expect(await ds.read('k')).toBeNull();
  });

  it('E103 写嵌套 Infinity(数组内)→ 抛', async () => {
    const ds = new InMemoryDataStore();
    await expect(ds.write('k', { list: [1, Infinity, 3] })).rejects.toThrow();
  });

  it('E103 合法 JSON 安全值 → 正常写入', async () => {
    const ds = new InMemoryDataStore();
    await ds.write('k', { a: 1, b: 'x', c: true, d: null, e: [1, 2] });
    expect(await ds.read('k')).toEqual({
      a: 1,
      b: 'x',
      c: true,
      d: null,
      e: [1, 2],
    });
  });

  // 边界(E136,E103 同族):JSON.stringify 对非 plain object 静默改写 —— Date/带 toJSON → 字符串,
  // Map/Set/class instance → {}。write 须拒绝(否则「成功」但持久化的是变形数据)。
  it('E136 写非 plain object(Date/Map/Set/class)→ 抛,不写入', async () => {
    const ds = new InMemoryDataStore();
    class Custom {
      constructor(public n = 1) {}
    }
    for (const bad of [
      new Date(),
      new Map([['a', 1]]),
      new Set([1, 2]),
      new Custom(),
      { nested: new Date() }, // 嵌套也拒
    ]) {
      await expect(ds.write('k', bad)).rejects.toThrow(/non-plain|non-JSON/i);
    }
    expect(await ds.read('k')).toBeNull();
  });

  it('E136 plain object(字面量 / Object.create(null))→ 正常写入', async () => {
    const ds = new InMemoryDataStore();
    await ds.write('lit', { a: 1 });
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.b = 2;
    await ds.write('np', nullProto);
    expect(await ds.read('lit')).toEqual({ a: 1 });
    expect(await ds.read('np')).toEqual({ b: 2 });
  });

  // 边界(E140,E136 深化):plain object 的 symbol key(JSON 静默丢)/ 非枚举自有属性(含非枚举
  // toJSON,改写序列化)→ 「校验通过但 stringify 不忠实」。write 须拒绝。
  it('E140 写含 symbol key 的对象 → 抛(JSON 静默丢该字段)', async () => {
    const ds = new InMemoryDataStore();
    const withSym: Record<string, unknown> = { a: 1 };
    (withSym as Record<symbol, unknown>)[Symbol('s')] = 2;
    await expect(ds.write('k', withSym)).rejects.toThrow(/symbol key|non-/i);
    expect(await ds.read('k')).toBeNull();
  });

  it('E140 写含非枚举自有属性的对象(含非枚举 toJSON)→ 抛', async () => {
    const ds = new InMemoryDataStore();
    const hidden: Record<string, unknown> = { a: 1 };
    Object.defineProperty(hidden, 'secret', { value: 9, enumerable: false });
    await expect(ds.write('k', hidden)).rejects.toThrow(/non-enumerable|non-/i);

    const withToJson: Record<string, unknown> = { a: 1 };
    Object.defineProperty(withToJson, 'toJSON', {
      value: () => 'transformed',
      enumerable: false,
    });
    await expect(ds.write('k2', withToJson)).rejects.toThrow(
      /non-enumerable|non-/i,
    );
    expect(await ds.read('k')).toBeNull();
    expect(await ds.read('k2')).toBeNull();
  });
});

describe('Plugin.loadData / saveData', () => {
  it('saveData → dataStore.write,loadData → dataStore.read', async () => {
    const app = createTestApp();
    class P extends Plugin {
      onload() {}
      async testSave(d: unknown) {
        await this.saveData(d);
      }
      async testLoad<T>(): Promise<T | null> {
        return this.loadData<T>();
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    await p.testSave({ pref: 'dark' });
    const got = await p.testLoad<{ pref: string }>();
    expect(got).toEqual({ pref: 'dark' });
  });

  it('loadData 未写过 → null', async () => {
    const app = createTestApp();
    class P extends Plugin {
      onload() {}
      async testLoad<T>(): Promise<T | null> {
        return this.loadData<T>();
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    expect(await p.testLoad()).toBeNull();
  });

  it('dataStore.read 抛错 → loadData 返 null + warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createTestApp();
    app.dataStore.read = () => Promise.reject(new Error('IO fail'));
    class P extends Plugin {
      onload() {}
      async testLoad() {
        return this.loadData();
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    expect(await p.testLoad()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('saveData 抛错向上传(不吞)', async () => {
    const app = createTestApp();
    app.dataStore.write = () => Promise.reject(new Error('disk full'));
    class P extends Plugin {
      onload() {}
      async testSave(d: unknown) {
        await this.saveData(d);
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    await expect(p.testSave({ x: 1 })).rejects.toThrow('disk full');
  });
});
