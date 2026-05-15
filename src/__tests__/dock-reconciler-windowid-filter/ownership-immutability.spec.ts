import { describe, expect as vitestExpect, it } from 'vitest';

const expect = vitestExpect as typeof vitestExpect & {
  fail: (message?: string) => never;
};
expect.fail ??= (message = 'expect.fail'): never => {
  throw new Error(message);
};

describe('dock-reconciler-windowid-filter: INV-2 renderer defense', () => {
  it('T15 prev=[A:o1] next=[A:o2] -> filter 后 prev=[A] next=[] -> A 标 removed', () => {
    expect.fail('green by Op3');
  });
});
