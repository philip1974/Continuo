// perf(r-fresh #6):outermostPaths 原为两两 isSameOrInsidePath 的 O(N²),剪贴板 prune 为
// clipboard × removed。改为祖先索引后,输出必须与旧两两比较实现逐项一致 —— 包括 Windows
// 大小写不敏感 / 混合分隔符 / 尾部分隔符 / 纯分隔符根 / 空串 / 重复项(只留首个)等边角。
// 这里内联旧实现作参照,随机 + 边界集合在 posix 与 win32 两种运行时下逐项比对。
import { afterEach, describe, expect, it } from 'vitest';
import { isSameOrInsidePath, pathEquals } from '@/lib/path-cross';
import { outermostPaths } from '@/panels/Explorer/path-utils';
import { pruneClipboardPaths } from '@/panels/Explorer/clipboard-store';

function refOutermost(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]!;
    let covered = false;
    for (let j = 0; j < paths.length && !covered; j++) {
      if (j === i) continue;
      const q = paths[j]!;
      if (isSameOrInsidePath(q, p)) covered = !pathEquals(q, p) || j < i;
    }
    if (!covered) out.push(p);
  }
  return out;
}

function refPrune(paths: readonly string[], removed: readonly string[]): string[] {
  return paths.filter((p) => !removed.some((r) => isSameOrInsidePath(r, p)));
}

// 确定性 PRNG(mulberry32),失败可复现。
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEGMENTS = ['a', 'A', 'b', 'B', 'ab', 'é', 'É', 'İ', 'ß', 'x.ts', 'X.TS'];
const SEPS = ['/', '/', '\\'];
const PREFIXES = ['', '/', 'C:', 'c:', '\\\\srv'];

function randomPath(r: () => number): string {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  if (r() < 0.04) return pick(['', '/', '//', '\\', 'C:\\', 'c:/']);
  let s = pick(PREFIXES);
  const depth = 1 + Math.floor(r() * 4);
  for (let d = 0; d < depth; d++) s += pick(SEPS) + pick(SEGMENTS);
  if (r() < 0.15) s += pick(SEPS);
  if (r() < 0.05) s += pick(SEPS);
  return s;
}

function randomSet(r: () => number): string[] {
  const n = Math.floor(r() * 14);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    // 30% 复用已有项(制造重复/大小写变体)
    if (out.length > 0 && r() < 0.3) {
      const base = out[Math.floor(r() * out.length)]!;
      out.push(r() < 0.5 ? base : base.toUpperCase());
    } else {
      out.push(randomPath(r));
    }
  }
  return out;
}

const EDGE_SETS: string[][] = [
  [],
  ['/a'],
  ['/a', '/a'],
  ['/a', '/a/'],
  ['/a/', '/a'],
  ['/a', '/A'],
  ['/a', '/a/b', '/a\\c', '/ab'],
  ['/a/b', '/a'],
  ['/', '/a', '/b/c'],
  ['//', '/'],
  ['', '/a'],
  ['/a', ''],
  ['C:\\Repo\\src', 'c:\\repo', 'C:\\REPO\\x'],
  ['C:\\', 'C:\\x', 'D:\\y'],
  ['C:', 'C:\\x'],
  ['/a/b/', '/a/b/c', '/a/b'],
  ['/x/İ/a', '/x/i̇', '/x/İ'],
  ['/a//b', '/a/', '/a'],
];

const setPlatform = (value: string) =>
  Object.defineProperty(navigator, 'platform', { value, configurable: true });
const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
afterEach(() => {
  if (orig) Object.defineProperty(navigator, 'platform', orig);
  else delete (navigator as { platform?: string }).platform;
});

describe.each([
  ['posix', 'MacIntel'],
  ['win32', 'Win32'],
])('祖先索引与旧两两比较逐项一致(%s)', (_name, platform) => {
  it('outermostPaths:边界集合', () => {
    setPlatform(platform);
    for (const set of EDGE_SETS) expect(outermostPaths(set), JSON.stringify(set)).toEqual(refOutermost(set));
  });

  it('outermostPaths:随机集合', () => {
    setPlatform(platform);
    const r = rng(platform === 'Win32' ? 7 : 3);
    for (let n = 0; n < 3000; n++) {
      const set = randomSet(r);
      expect(outermostPaths(set), JSON.stringify(set)).toEqual(refOutermost(set));
    }
  });

  it('pruneClipboardPaths:边界与随机集合', () => {
    setPlatform(platform);
    for (const a of EDGE_SETS) {
      for (const b of EDGE_SETS) {
        expect([...pruneClipboardPaths(a, b)], JSON.stringify([a, b])).toEqual(refPrune(a, b));
      }
    }
    const r = rng(platform === 'Win32' ? 11 : 5);
    for (let n = 0; n < 3000; n++) {
      const a = randomSet(r);
      const b = r() < 0.5 ? randomSet(r) : a.slice(0, Math.floor(r() * a.length));
      expect([...pruneClipboardPaths(a, b)], JSON.stringify([a, b])).toEqual(refPrune(a, b));
    }
  });
});
