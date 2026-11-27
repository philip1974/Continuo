// TDD:保存冲突差异视图的纯逻辑。见同目录 README。
import { describe, expect, it } from 'vitest';
import {
  CONFLICT_DIFF_INLINE_BREAKPOINT,
  CONFLICT_DIFF_MAX_CHARS,
  chunkIndexAt,
  conflictDiffLayoutFor,
  dirChangeTouchesFile,
  isConflictDiffTooLarge,
} from '@/panels/Editor/conflict-diff-model';

describe('isConflictDiffTooLarge', () => {
  it('两侧合计超过上限才算过大', () => {
    expect(isConflictDiffTooLarge(CONFLICT_DIFF_MAX_CHARS / 2, CONFLICT_DIFF_MAX_CHARS / 2)).toBe(false);
    expect(isConflictDiffTooLarge(CONFLICT_DIFF_MAX_CHARS / 2, CONFLICT_DIFF_MAX_CHARS / 2 + 1)).toBe(true);
  });
});

describe('chunkIndexAt', () => {
  const chunks = [
    { fromA: 0, endA: 5, fromB: 0, endB: 3 },
    { fromA: 20, endA: 30, fromB: 18, endB: 18 },
  ];
  it('按光标所在侧找块(含两端)', () => {
    expect(chunkIndexAt(chunks, 4, 'a')).toBe(0);
    expect(chunkIndexAt(chunks, 4, 'b')).toBe(-1);
    expect(chunkIndexAt(chunks, 30, 'a')).toBe(1);
    expect(chunkIndexAt(chunks, 18, 'b')).toBe(1);
  });
  it('不在任何块里 → -1', () => {
    expect(chunkIndexAt(chunks, 10, 'a')).toBe(-1);
    expect(chunkIndexAt([], 0, 'b')).toBe(-1);
  });
});

describe('dirChangeTouchesFile', () => {
  it('父目录相同且无文件名集合 → 命中', () => {
    expect(dirChangeTouchesFile('/w/src', undefined, '/w/src/a.ts')).toBe(true);
    expect(dirChangeTouchesFile('/w/src', null, '/w/src/a.ts')).toBe(true);
  });
  it('文件名集合含该文件(大小写 / NFC 折叠)→ 命中;不含 → 不命中', () => {
    expect(dirChangeTouchesFile('/w/src', ['b.ts', 'a.ts'], '/w/src/a.ts')).toBe(true);
    expect(dirChangeTouchesFile('/w/src', ['b.ts'], '/w/src/a.ts')).toBe(false);
    expect(dirChangeTouchesFile('/w', ['한.md'.normalize('NFD')], '/w/한.md'.normalize('NFC'))).toBe(true);
  });
  it('别的目录不命中;符号链接按真实目标也能命中', () => {
    expect(dirChangeTouchesFile('/w/lib', undefined, '/w/src/a.ts')).toBe(false);
    expect(dirChangeTouchesFile('/real', ['t.ts'], '/w/link.ts', '/real/t.ts')).toBe(true);
  });
});

describe('conflictDiffLayoutFor(VSCode useInlineViewWhenSpaceIsLimited,width <= 900 → 内联)', () => {
  it('≤ 900 内联,> 900 并排', () => {
    expect(CONFLICT_DIFF_INLINE_BREAKPOINT).toBe(900);
    expect(conflictDiffLayoutFor(900, 'split')).toBe('unified');
    expect(conflictDiffLayoutFor(196, 'split')).toBe('unified');
    expect(conflictDiffLayoutFor(901, 'unified')).toBe('split');
  });
  it('宽度未知(0 / NaN:隐藏或尚未布局)→ 保持当前布局', () => {
    expect(conflictDiffLayoutFor(0, 'split')).toBe('split');
    expect(conflictDiffLayoutFor(0, 'unified')).toBe('unified');
    expect(conflictDiffLayoutFor(Number.NaN, 'unified')).toBe('unified');
  });
});
