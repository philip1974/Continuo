import { describe, expect as vitestExpect, it } from 'vitest';

const expect = vitestExpect as typeof vitestExpect & {
  fail: (message?: string) => never;
};
expect.fail ??= (message = 'expect.fail'): never => {
  throw new Error(message);
};

describe('dock-reconciler-windowid-filter: filterByOwnerWindow pure fn', () => {
  it('T1 空数组 -> 空', () => {
    expect.fail('green by Op3');
  });

  it('T2 [A:o1] wid=1 -> [A]', () => {
    expect.fail('green by Op3');
  });

  it('T3 [A:o1, B:o2] wid=1 -> [A] + 顺序保留', () => {
    expect.fail('green by Op3');
  });

  it('T4 [A:o2, B:o2] wid=1 -> [] 全过滤', () => {
    expect.fail('green by Op3');
  });

  it("T5 [null, A:o1] wid=1 -> [A] + onDrop('not-object', undefined)", () => {
    expect.fail('green by Op3');
  });

  it("T6 [42, 'string', A:o1] wid=1 -> [A] + onDrop('not-object', undefined) x2", () => {
    expect.fail('green by Op3');
  });

  it("T7 [{无 ownerWindowId, id:'X', ...}, A:o1] wid=1 -> [A] + onDrop('missing-owner', 'X')", () => {
    expect.fail('green by Op3');
  });

  it("T8 [{id:'B', ownerWindowId:2, ...其他完整}, A:o1] wid=1 -> [A] + onDrop('wrong-owner', 'B')", () => {
    expect.fail('green by Op3');
  });

  it("T9 [{id:'B', ownerWindowId:1, title:undefined, ...}] wid=1 -> [] + onDrop('shape-invalid', 'B')", () => {
    expect.fail('green by Op3');
  });

  it('T10 filterByOwnerWindow 调 console.warn spy 0 次(纯函数无 console)', () => {
    expect.fail('green by Op3');
  });
});
