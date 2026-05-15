import { describe, expect as vitestExpect, it } from 'vitest';

const expect = vitestExpect as typeof vitestExpect & {
  fail: (message?: string) => never;
};
expect.fail ??= (message = 'expect.fail'): never => {
  throw new Error(message);
};

describe('dock-reconciler-windowid-filter: runtime guard', () => {
  it("T16 输入含 null payload -> 不抛 + onDrop('not-object') 一次", () => {
    expect.fail('green by Op3');
  });

  it("T17 输入含 non-object(number/string) -> 不抛 + onDrop('not-object')", () => {
    expect.fail('green by Op3');
  });

  it("T18 shape-invalid 多 case: id non-string / createdAt non-number / exitCode undefined / originHint invalid / cwd 缺失", () => {
    expect.fail('green by Op3');
  });
});
