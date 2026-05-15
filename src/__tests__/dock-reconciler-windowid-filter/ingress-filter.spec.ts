// @vitest-environment jsdom
import { describe, expect as vitestExpect, it } from 'vitest';

const expect = vitestExpect as typeof vitestExpect & {
  fail: (message?: string) => never;
};
expect.fail ??= (message = 'expect.fail'): never => {
  throw new Error(message);
};

describe('dock-reconciler-windowid-filter: renderer ingress filter', () => {
  it('T11 TerminalSessionsSync listSessions 响应 -> useTerminalStore.replaceSnapshot 收到 filtered', () => {
    expect.fail('green by Op3');
  });

  it('T12 TerminalSessionsSync onSessionsChanged 多次 -> 持续 filtered', () => {
    expect.fail('green by Op3');
  });

  it('T13 LegacyTerminalPanel listSessions(render <TerminalPanel /> 无 props.api 触发 legacy 分支) -> store 收 filtered', () => {
    expect.fail('green by Op3');
  });

  it('T14 LegacyTerminalPanel onSessionsChanged -> store 收 filtered', () => {
    expect.fail('green by Op3');
  });
});
