// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  TerminalSessionsSync,
  _resetTerminalDropWarningsForTest,
} from '../../shell/dock/TerminalSessionsSync';

const mocks = vi.hoisted(() => ({
  windowId: NaN as number | undefined,
  listSessions: vi.fn(),
  onSessionsChanged: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    system: {
      get windowId() {
        return mocks.windowId;
      },
    },
    terminal: {
      listSessions: mocks.listSessions,
      onSessionsChanged: mocks.onSessionsChanged,
    },
  },
}));

afterEach(() => {
  cleanup();
});

describe('dock-reconciler-windowid-filter: non-finite current window id', () => {
  it("T21 coApi.system.windowId 为 NaN / Infinity / undefined -> 不调用 terminal ingress + warn 一次含 'not finite'", () => {
    for (const value of [NaN, Infinity, undefined]) {
      cleanup();
      _resetTerminalDropWarningsForTest();
      mocks.windowId = value;
      mocks.listSessions.mockClear();
      mocks.onSessionsChanged.mockClear();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      render(React.createElement(TerminalSessionsSync));
      expect(mocks.listSessions).not.toHaveBeenCalled();
      expect(mocks.onSessionsChanged).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('not finite');
      warn.mockRestore();
    }
  });
});
