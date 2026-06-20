// @vitest-environment jsdom
// 第十一轮 · P2-AA TerminalSessionsSync 初始 hydration 不覆盖更新的实时推送
//
// listSessions()(请求/响应)与 onSessionsChanged(广播)是两条独立路径,可乱序到达。
// 旧实现:若推送先到带新会话、初始 listSessions 后 resolve 带旧快照 → replaceSnapshot
// 用旧快照覆盖 → 刚创建的会话从 tab 栏短暂消失(自愈于下次推送,但已可见错误)。
// 修复:一旦收到任何实时推送,订阅即权威,丢弃迟到的初始 listSessions 结果。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { TerminalSessionsSync } from '../../shell/dock/TerminalSessionsSync';
import {
  useTerminalStore,
  type TerminalSession,
} from '../../stores/terminal.store';

const mocks = vi.hoisted(() => {
  let onChanged: ((sessions: TerminalSession[]) => void) | null = null;
  return {
    listSessions: vi.fn(),
    unsubscribe: vi.fn(),
    onSessionsChanged: vi.fn((cb: (sessions: TerminalSession[]) => void) => {
      onChanged = cb;
      return mocks.unsubscribe;
    }),
    emitSessionsChanged: (sessions: TerminalSession[]) => onChanged?.(sessions),
  };
});

vi.mock('@/lib/co-api', () => ({
  coApi: {
    system: { windowId: 1 },
    terminal: {
      listSessions: mocks.listSessions,
      onSessionsChanged: mocks.onSessionsChanged,
    },
  },
}));

function session(id: string): TerminalSession {
  return {
    id,
    title: id,
    cwd: '/repo',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ownerWindowId: 1,
  };
}

beforeEach(() => {
  mocks.listSessions.mockReset();
  mocks.unsubscribe.mockReset();
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

describe('49 · TerminalSessionsSync 迟到 listSessions 不覆盖实时推送', () => {
  it('推送先到(新会话)→ listSessions 后 resolve(旧快照)→ 保留推送结果', async () => {
    // listSessions 延迟 resolve,模拟在 push 之后才回来
    let resolveList!: (v: unknown) => void;
    mocks.listSessions.mockReturnValue(
      new Promise((res) => {
        resolveList = res;
      }),
    );

    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(mocks.onSessionsChanged).toHaveBeenCalledTimes(1);
    });

    // 实时推送先到:窗口期内新建了 s-new
    act(() => {
      mocks.emitSessionsChanged([session('s-new')]);
    });
    expect(useTerminalStore.getState().sessions.map((s) => s.id)).toEqual([
      's-new',
    ]);

    // 迟到的初始 listSessions 带的是更早的空快照 → 必须被丢弃
    await act(async () => {
      resolveList({ ok: true, data: { sessions: [] } });
      await Promise.resolve();
    });

    expect(useTerminalStore.getState().sessions.map((s) => s.id)).toEqual([
      's-new',
    ]);
  });

  it('正常顺序:listSessions 先 resolve → 后续推送仍能更新', async () => {
    mocks.listSessions.mockResolvedValue({
      ok: true,
      data: { sessions: [session('s1')] },
    });

    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(useTerminalStore.getState().sessions.map((s) => s.id)).toEqual([
        's1',
      ]);
    });

    act(() => {
      mocks.emitSessionsChanged([session('s1'), session('s2')]);
    });
    expect(useTerminalStore.getState().sessions.map((s) => s.id)).toEqual([
      's1',
      's2',
    ]);
  });
});
