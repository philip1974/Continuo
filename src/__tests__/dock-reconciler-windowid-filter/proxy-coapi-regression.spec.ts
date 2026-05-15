// @vitest-environment jsdom
//
// REGRESSION: topic-09 Op3 偏离 plan-v4 自加 `if (!('system' in api)) return 1` 哨兵,
// 引发双窗第二窗 terminal 全被 ingress filter drop 为 `wrong-owner`(用户实测报告 2026-05-15)。
//
// 根因:PROD `coApi` 是 ES Proxy(target = `{}`,无 `has` trap),`'system' in coApi`
// 默认走 `Reflect.has({}, 'system') === false` → 哨兵 fallback `winId = 1`。
// 其他 spec 用 plain object mock `coApi`,`'system' in plainObj === true` → 绕过 bug。
//
// 此 spec 用 真实 Proxy(target = `{}`)mock `coApi`,锁住 SessionsSync 必须读到
// **真实 windowId**(非 fallback 1)。任何回退到 `'system' in api` 形态的实装都会
// 立即在此 spec 标红。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import {
  TerminalSessionsSync,
  _resetTerminalDropWarningsForTest,
} from '../../shell/dock/TerminalSessionsSync';
import {
  useTerminalStore,
  type TerminalSession,
} from '../../stores/terminal.store';

const mocks = vi.hoisted(() => {
  let onChanged: ((sessions: unknown[]) => void) | null = null;
  return {
    windowId: 2 as number,
    listSessions: vi.fn(),
    onSessionsChanged: vi.fn((cb: (sessions: unknown[]) => void) => {
      onChanged = cb;
      return vi.fn();
    }),
    emitSessionsChanged: (sessions: unknown[]) => onChanged?.(sessions),
  };
});

vi.mock('@/lib/co-api', () => {
  const liveApi = {
    system: {
      get windowId() {
        return mocks.windowId;
      },
    },
    terminal: {
      listSessions: mocks.listSessions,
      onSessionsChanged: mocks.onSessionsChanged,
    },
  };
  // PROD 形态:target = `{}` (空对象),`has` 默认行为返回 false。
  const coApi = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      return (liveApi as Record<string | symbol, unknown>)[prop as string];
    },
  });
  return { coApi };
});

function session(id: string, ownerWindowId: number): TerminalSession {
  return {
    id,
    title: id,
    cwd: '/repo',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ownerWindowId,
  };
}

beforeEach(() => {
  _resetTerminalDropWarningsForTest();
  mocks.windowId = 2;
  mocks.listSessions.mockReset();
  mocks.listSessions.mockResolvedValue({ ok: true, data: { sessions: [] } });
  mocks.onSessionsChanged.mockClear();
  useTerminalStore.setState({
    sessions: [],
    activeId: null,
    customTitles: new Map(),
  });
});

afterEach(() => {
  cleanup();
});

describe('dock-reconciler-windowid-filter: PROD Proxy coApi regression', () => {
  it("REGRESSION coApi 是 ES Proxy(target=`{}` 无 has trap)时 SessionsSync 读到真实 winId=2(不回退 fallback 1)", async () => {
    const win2 = session('term-w2', 2);
    mocks.listSessions.mockResolvedValueOnce({
      ok: true,
      data: { sessions: [win2] },
    });
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(useTerminalStore.getState().sessions).toHaveLength(1);
    });
    expect(useTerminalStore.getState().sessions[0]?.id).toBe('term-w2');
  });

  it('REGRESSION Proxy coApi - ownerWindowId=1 的 session 被正确 drop(winId=2)+ warn `wrong-owner`', async () => {
    const win1 = session('term-w1', 1);
    const win2 = session('term-w2', 2);
    mocks.listSessions.mockResolvedValueOnce({
      ok: true,
      data: { sessions: [win1, win2] },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(useTerminalStore.getState().sessions).toHaveLength(1);
    });
    expect(useTerminalStore.getState().sessions[0]?.id).toBe('term-w2');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('wrong-owner'),
      'term-w1',
    );
    warnSpy.mockRestore();
  });
});
