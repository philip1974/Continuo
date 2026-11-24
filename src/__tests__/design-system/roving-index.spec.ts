import { describe, expect, it } from 'vitest';
import { indexOfElement, nextRovingIndex } from '../../design/roving-index';

// tablist 与菜单共用的焦点轮转下标规则:Home/End 到首末,next/prev 循环,当前项不在列表(-1)时 next→首项、prev→末项。
describe('nextRovingIndex', () => {
  it.each([
    ['first', 2, 4, 0],
    ['last', 0, 4, 3],
    ['next', 1, 4, 2],
    ['next', 3, 4, 0],
    ['next', -1, 4, 0],
    ['prev', 2, 4, 1],
    ['prev', 0, 4, 3],
    ['prev', -1, 4, 3],
  ] as const)('%s from %i (count %i) → %i', (move, idx, count, expected) => {
    expect(nextRovingIndex(move, idx, count)).toBe(expected);
  });
});

describe('indexOfElement', () => {
  it('按引用找下标;不在或 null → -1', () => {
    const a = document.createElement('button');
    const b = document.createElement('button');
    expect(indexOfElement([a, b], b)).toBe(1);
    expect(indexOfElement([a], b)).toBe(-1);
    expect(indexOfElement([a], null)).toBe(-1);
  });
});
