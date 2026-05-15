// @vitest-environment jsdom
import { describe, expect as vitestExpect, it } from 'vitest';

const expect = vitestExpect as typeof vitestExpect & {
  fail: (message?: string) => never;
};
expect.fail ??= (message = 'expect.fail'): never => {
  throw new Error(message);
};

describe('dock-reconciler-windowid-filter: non-finite current window id', () => {
  it("T21 coApi.system.windowId 为 NaN / Infinity / undefined -> 不调用 terminal ingress + warn 一次含 'not finite'", () => {
    expect.fail('green by Op3');
  });
});
