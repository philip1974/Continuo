import { describe, expect as vitestExpect, it } from 'vitest';

const expect = vitestExpect as typeof vitestExpect & {
  fail: (message?: string) => never;
};
expect.fail ??= (message = 'expect.fail'): never => {
  throw new Error(message);
};

describe('dock-reconciler-windowid-filter: single-window noop', () => {
  it('T19 全 ownerWindowId === currentWindowId -> filterByOwnerWindow(s, w) 深 equal s(identity 等价)', () => {
    expect.fail('green by Op3');
  });
});
