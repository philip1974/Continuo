// perf:主进程有 Buffer 时 utf8ByteLength / utf8BytesExceed 走原生 Buffer.byteLength(1MB ASCII ~0.16ms,
// 纯 JS 逐字符 1.4–3.1ms);renderer(sandbox,无 Buffer)回退 JS 循环。两条路径对边界输入结果必须一致。
import { afterEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('../utf8-byte-length');

const CASES: string[] = [
  '',
  'a',
  'abc',
  '\uD800', // 孤立高代理
  '\uDC00', // 孤立低代理
  '\uDBFF',
  '\uD800中', // 孤立高代理 + 多字节(E126)
  'x\uDC00\uD800y',
  'a𐀀b', // 代理对
  '😀',
  '中文😀',
  'é',
  'x'.repeat(1000) + '🌍',
  '中'.repeat(700), // 2100 bytes
];

// 模块加载时探测 Buffer.byteLength。只在模块求值期间替换它(整体移除 globalThis.Buffer 会弄坏 vitest 自身
// 运行时),随即恢复 —— 等价于 renderer「无可用原生 byteLength」的环境。
async function loadWithByteLength(fake: unknown): Promise<Mod> {
  vi.resetModules();
  const B = Buffer as unknown as { byteLength: unknown };
  const orig = B.byteLength;
  B.byteLength = fake;
  try {
    return await import('../utf8-byte-length');
  } finally {
    B.byteLength = orig;
  }
}

const loadJsOnly = (): Promise<Mod> => loadWithByteLength(undefined);

async function loadNative(): Promise<Mod> {
  vi.resetModules();
  return import('../utf8-byte-length');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('utf8-byte-length 原生 / JS 双路径', () => {
  it('有 Buffer 时 utf8ByteLength 走原生 Buffer.byteLength', async () => {
    const mod = await loadNative();
    const spy = vi.spyOn(Buffer, 'byteLength');
    expect(mod.utf8ByteLength('中文😀')).toBe(10);
    expect(spy).toHaveBeenCalled();
  });

  it('有 Buffer 时 utf8BytesExceed 在落入 [max/3, max] 区间才调原生;两个长度前置判定不调用', async () => {
    const mod = await loadNative();
    const spy = vi.spyOn(Buffer, 'byteLength');
    expect(mod.utf8BytesExceed('abcd', 3)).toBe(true); // .length > max
    expect(mod.utf8BytesExceed('ab', 6)).toBe(false); // .length*3 <= max
    expect(spy).not.toHaveBeenCalled();
    expect(mod.utf8BytesExceed('中中', 5)).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it('无 Buffer(renderer)回退 JS 循环,结果与原生 / TextEncoder 一致', async () => {
    const js = await loadJsOnly();
    const nat = await loadNative();
    const enc = new TextEncoder();
    for (const s of CASES) {
      const truth = enc.encode(s).length;
      expect(js.utf8ByteLength(s)).toBe(truth);
      expect(nat.utf8ByteLength(s)).toBe(truth);
      // 恰好等于上限 / 上限 ±1,以及跨越两个前置判定区间的若干上限
      for (const max of [truth - 1, truth, truth + 1, s.length, s.length * 3, Math.ceil(s.length * 1.5)]) {
        if (max < 0) continue;
        expect(js.utf8BytesExceed(s, max)).toBe(truth > max);
        expect(nat.utf8BytesExceed(s, max)).toBe(truth > max);
      }
    }
  });

  it('Buffer 存在但 byteLength 口径不符(异常 polyfill)时不采用,回退 JS', async () => {
    const mod = await loadWithByteLength((s: string) => s.length);
    expect(mod.utf8ByteLength('\uD800中')).toBe(6);
    expect(mod.utf8BytesExceed('中中', 5)).toBe(true);
  });
});
