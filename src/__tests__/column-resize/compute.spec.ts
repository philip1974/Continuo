import { describe, it, expect } from 'vitest';
import {
  clampWidth,
  computeNewWidth,
} from '../../lib/use-column-resize';

describe('clampWidth', () => {
  it('在范围内 → 原值', () => {
    expect(clampWidth(280, 200, 500)).toBe(280);
  });
  it('超 max → max', () => {
    expect(clampWidth(600, 200, 500)).toBe(500);
  });
  it('低于 min → min', () => {
    expect(clampWidth(100, 200, 500)).toBe(200);
  });
  it('等于边界值 → 原值', () => {
    expect(clampWidth(200, 200, 500)).toBe(200);
    expect(clampWidth(500, 200, 500)).toBe(500);
  });
  it('NaN → min(防御)', () => {
    expect(clampWidth(NaN, 200, 500)).toBe(200);
  });
});

describe('computeNewWidth · left-to-right(左侧栏拖右边)', () => {
  it('向右拖 → 增宽', () => {
    expect(computeNewWidth(100, 280, 150, 200, 500)).toBe(330);
  });
  it('向左拖 → 减宽', () => {
    expect(computeNewWidth(100, 280, 50, 200, 500)).toBe(230);
  });
  it('超出 max → 截到 max', () => {
    expect(computeNewWidth(100, 280, 1000, 200, 500)).toBe(500);
  });
  it('低于 min → 截到 min', () => {
    expect(computeNewWidth(100, 280, -1000, 200, 500)).toBe(200);
  });
  it('原地不动 → 原值', () => {
    expect(computeNewWidth(100, 280, 100, 200, 500)).toBe(280);
  });
});

describe('computeNewWidth · right-to-left(右侧栏拖左边)', () => {
  it('向右拖 → 减宽', () => {
    expect(
      computeNewWidth(100, 280, 150, 200, 500, 'right-to-left'),
    ).toBe(230);
  });
  it('向左拖 → 增宽', () => {
    expect(
      computeNewWidth(100, 280, 50, 200, 500, 'right-to-left'),
    ).toBe(330);
  });
});
