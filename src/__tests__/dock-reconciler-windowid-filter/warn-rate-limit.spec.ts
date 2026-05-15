import { beforeEach, describe, expect as vitestExpect, it } from 'vitest';

const expect = vitestExpect as typeof vitestExpect & {
  fail: (message?: string) => never;
};
expect.fail ??= (message = 'expect.fail'): never => {
  throw new Error(message);
};

beforeEach(async () => {
  const storeModule = await import('../../stores/terminal.store') as unknown as {
    _resetTerminalDropWarningsForTest?: () => void;
  };
  storeModule._resetTerminalDropWarningsForTest?.();
});

describe('dock-reconciler-windowid-filter: warn rate limit', () => {
  it('T20 同 sessionId+reason 多次推送 -> console.warn 调一次', () => {
    expect.fail('green by Op3');
  });
});
