// @vitest-environment jsdom
// topic 49 第十二 session · codex 复审 loop R12:TerminalSessionsSync 必须按当前 workspace 过滤可见 session。
//
// 根因:TerminalSession.workspaceRoot 的契约(terminal-sessions.service.ts:52 + 字段注释)是
// renderer 按当前 workspace 过滤可见 session:visible = workspaceRoot===undefined(全局) ||
// workspaceRoot===currentRoot。但 TerminalSessionsSync 两条路径只 filterByOwnerWindow(winId),
// 没订阅 useWorkspaceStore.root、不按 workspaceRoot 过滤 → 同窗口切 workspace 后,旧项目的
// terminal(workspaceRoot=旧根)仍进 store/显示,用户可能在错误 cwd 执行命令。违反文档契约 = 真 bug。
//
// 修:抽 filterByWorkspaceRoot(sessions, currentRoot),Sync 留 owner-过滤后的 raw 快照 +
// 订阅 root 变化重新过滤(PTY 不杀,切回旧根能重现)。

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { TerminalSessionsSync } from '../../shell/dock/TerminalSessionsSync';
import {
  filterByWorkspaceRoot,
  useTerminalStore,
  type TerminalSession,
} from '../../stores/terminal.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

const mocks = vi.hoisted(() => {
  let onChanged: ((sessions: TerminalSession[]) => void) | null = null;
  return {
    listSessions: vi.fn(),
    unsubscribe: vi.fn(),
    onSessionsChanged: vi.fn((cb: (sessions: TerminalSession[]) => void) => {
      onChanged = cb;
      return mocks.unsubscribe;
    }),
    emit: (sessions: TerminalSession[]) => onChanged?.(sessions),
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

function session(id: string, workspaceRoot?: string): TerminalSession {
  return {
    id,
    title: id,
    cwd: workspaceRoot ?? '/repo',
    originHint: workspaceRoot ? 'user' : 'agent',
    createdAt: 1,
    exitCode: null,
    ownerWindowId: 1,
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
  };
}

beforeEach(() => {
  mocks.listSessions.mockReset();
  mocks.listSessions.mockResolvedValue({ ok: true, data: { sessions: [] } });
  mocks.unsubscribe.mockReset();
  mocks.onSessionsChanged.mockClear();
  useTerminalStore.setState({ sessions: [], activeId: null, customTitles: new Map() });
  useWorkspaceStore.setState({ root: null });
});

afterEach(() => cleanup());

describe('topic49 codex-loop R12 · terminal 按 workspace 过滤', () => {
  it('filterByWorkspaceRoot:保留 global + 当前 root,隐藏别的 root', () => {
    const sessions = [session('a', '/proj-a'), session('b', '/proj-b'), session('g')];
    expect(filterByWorkspaceRoot(sessions, '/proj-a').map((s) => s.id)).toEqual(['a', 'g']);
    expect(filterByWorkspaceRoot(sessions, '/proj-b').map((s) => s.id)).toEqual(['b', 'g']);
    expect(filterByWorkspaceRoot(sessions, null).map((s) => s.id)).toEqual(['g']);
  });

  it('filterByWorkspaceRoot 空输入返回稳定空引用,避免空数组引用抖动', () => {
    const a: readonly TerminalSession[] = [];
    const b: readonly TerminalSession[] = [];
    const filtered = filterByWorkspaceRoot(a, '/proj-a');

    expect(filtered).toEqual([]);
    expect(filterByWorkspaceRoot(b, null)).toBe(filtered);
  });

  it('filterByWorkspaceRoot 全部可见时返回原引用,避免无意义数组分配', () => {
    const sessions = [session('a', '/proj-a'), session('g')];

    expect(filterByWorkspaceRoot(sessions, '/proj-a')).toBe(sessions);
    expect(filterByWorkspaceRoot.toString()).not.toContain(
      'const visible = new Array',
    );
  });

  it('filterByWorkspaceRoot 单次循环构建可见列表,不调用 sessions.filter', () => {
    const sessions = [session('a', '/proj-a'), session('b', '/proj-b'), session('g')];
    const filterSpy = vi.spyOn(sessions, 'filter');

    try {
      expect(filterByWorkspaceRoot(sessions, '/proj-a').map((s) => s.id)).toEqual([
        'a',
        'g',
      ]);
      expect(filterSpy).not.toHaveBeenCalled();
      expect(filterByWorkspaceRoot.toString()).not.toContain('visible.push(');
    } finally {
      filterSpy.mockRestore();
    }
  });

  it('切 workspace 后旧项目 terminal 从 store 隐藏,global 始终可见,切回重现', async () => {
    useWorkspaceStore.setState({ root: '/proj-a' });
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => expect(mocks.onSessionsChanged).toHaveBeenCalledTimes(1));

    // main 推来三 session:A(/proj-a)、B(/proj-b)、G(global)
    act(() => {
      mocks.emit([session('a', '/proj-a'), session('b', '/proj-b'), session('g')]);
    });
    // 当前 root=/proj-a → 只见 A + G
    expect(useTerminalStore.getState().sessions.map((s) => s.id).sort()).toEqual(['a', 'g']);

    // 切到 /proj-b → 旧项目 A 隐藏,见 B + G(无需 main 重推,据 raw 重新过滤)
    act(() => {
      useWorkspaceStore.setState({ root: '/proj-b' });
    });
    expect(useTerminalStore.getState().sessions.map((s) => s.id).sort()).toEqual(['b', 'g']);

    // 切回 /proj-a → A 重现(PTY 未杀,raw 仍含 A)
    act(() => {
      useWorkspaceStore.setState({ root: '/proj-a' });
    });
    expect(useTerminalStore.getState().sessions.map((s) => s.id).sort()).toEqual(['a', 'g']);
  });
});
