// 重构守卫:lowerIfNeeded 收口到 electron/shared/lower-if-needed.ts(此前 11 处逐字副本)。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('lowerIfNeeded', () => {
  it.each(['', 'abc', 'a-b_c.1', 'ABC', 'aBc', 'Ünï', 'ÉCOLE', '中文', 'cmd+K', 'İ'])(
    '结果恒等于 toLowerCase:%j',
    (value) => {
      expect(lowerIfNeeded(value)).toBe(value.toLowerCase());
    },
  );

  it('已是小写 ASCII → 原样返回', () => {
    const value = 'already-lower_123';
    expect(lowerIfNeeded(value)).toBe(value);
  });
});

describe('接线守卫:不得再本地复制 lowerIfNeeded', () => {
  // 语义不同的两个保留点:file-icon 的 ASCII-only 变体;filter 的非字符串兜底包装(委托 shared)。
  const ALLOWED = new Set([
    'electron/shared/lower-if-needed.ts',
    'src/panels/Explorer/file-icon.tsx',
    'src/marketplace/filter.ts',
  ]);

  it('src / electron 下无其他同名函数定义', () => {
    const offenders: string[] = [];
    for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'electron'))]) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      if (/function lowerIfNeeded\b/.test(readFileSync(file, 'utf-8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('marketplace/filter 的包装委托 shared 实现', () => {
    const src = readFileSync(path.join(ROOT, 'src/marketplace/filter.ts'), 'utf-8');
    expect(src).toMatch(/lower-if-needed'/);
  });
});
