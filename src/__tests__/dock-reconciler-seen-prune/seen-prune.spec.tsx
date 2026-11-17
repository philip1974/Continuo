// @vitest-environment jsdom
// DockReconciler 的 first-appearance 记录(R25 防 workspace 切回抢焦)此前只增不删,随进程内创建过的
// 终端总数无界增长。现由 TerminalSessionsSync 基于权威、未按 workspace 过滤的本窗口快照剪除:
//  - workspace 隐藏 → 仍在快照里 → 记录保留 → 切回不重新聚焦(R25 语义不变)
//  - 真正删除 → 从快照消失 → 记录剪除(有界);同 id 重建按首次出现处理
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import type { DockviewApi } from 'dockview-react';
import { TerminalSessionsSync } from '../../shell/dock/TerminalSessionsSync';
import {
  __reconcilerSeenSessionCountForTest,
  __resetReconcilerForTest,
  useDockReconciler,
} from '../../shell/dock/DockReconciler';
import { useTerminalStore, type TerminalSession } from '../../stores/terminal.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

const mocks = vi.hoisted(() => {
  let onChanged: ((sessions: unknown[]) => void) | null = null;
  return {
    onSessionsChanged: vi.fn((cb: (sessions: unknown[]) => void) => {
      onChanged = cb;
      return () => {};
    }),
    emit: (sessions: unknown[]) => onChanged?.(sessions),
  };
});

vi.mock('@/lib/co-api', () => ({
  coApi: {
    system: { windowId: 1 },
    terminal: {
      listSessions: vi.fn(() => new Promise(() => {})),
      onSessionsChanged: mocks.onSessionsChanged,
    },
  },
}));

function session(id: string, createdAt: number, workspaceRoot = '/proj-a'): TerminalSession {
  return {
    id,
    title: id,
    cwd: workspaceRoot,
    originHint: 'user',
    createdAt,
    exitCode: null,
    ownerWindowId: 1,
    workspaceRoot,
  };
}

type Panel = { id: string; api: { id: string; setActive: ReturnType<typeof vi.fn>; close: () => void; setTitle: ReturnType<typeof vi.fn>; title?: string } };

function makeApi() {
  const panels: Record<string, Panel> = {};
  const api = {
    activePanel: undefined as Panel | undefined,
    getPanel: vi.fn((id: string) => panels[id]),
    addPanel: vi.fn((opts: { id: string; title?: string }) => {
      const p: Panel = {
        id: opts.id,
        api: {
          id: opts.id,
          title: opts.title,
          setActive: vi.fn(),
          close: () => {
            delete panels[opts.id];
          },
          setTitle: vi.fn(),
        },
      };
      panels[opts.id] = p;
      api.activePanel = p;
      return p;
    }),
    panels,
  };
  return api;
}

beforeEach(() => {
  __resetReconcilerForTest();
  useTerminalStore.setState({ sessions: [] });
  useWorkspaceStore.setState({ root: '/proj-a' });
});
afterEach(() => cleanup());

function mount() {
  const api = makeApi();
  renderHook(() => useDockReconciler(api as unknown as DockviewApi, 0));
  render(React.createElement(TerminalSessionsSync));
  return api;
}

describe('DockReconciler first-appearance 记录按权威快照剪除', () => {
  it('workspace 隐藏再恢复:记录保留,切回不重新聚焦', () => {
    const api = mount();
    act(() => mocks.emit([session('t1', 10)]));
    expect(api.panels['terminal-t1']?.api.setActive).toHaveBeenCalledTimes(1);
    expect(__reconcilerSeenSessionCountForTest()).toBe(1);

    act(() => useWorkspaceStore.setState({ root: '/proj-b' }));
    expect(api.panels['terminal-t1']).toBeUndefined();
    // 快照再推一次(内容不变,仍含 t1)也不剪
    act(() => mocks.emit([session('t1', 10)]));
    expect(__reconcilerSeenSessionCountForTest()).toBe(1);

    act(() => useWorkspaceStore.setState({ root: '/proj-a' }));
    expect(api.panels['terminal-t1']).toBeDefined();
    expect(api.panels['terminal-t1']?.api.setActive).not.toHaveBeenCalled();
  });

  it('真正删除:记录被剪(不随历史创建数增长);同 id 重建按首次出现聚焦', () => {
    const api = mount();
    for (let i = 0; i < 20; i++) {
      act(() => mocks.emit([session(`t${i}`, i + 1)]));
    }
    expect(__reconcilerSeenSessionCountForTest()).toBe(1);

    act(() => mocks.emit([]));
    expect(__reconcilerSeenSessionCountForTest()).toBe(0);

    act(() => mocks.emit([session('t0', 100)]));
    expect(api.panels['terminal-t0']?.api.setActive).toHaveBeenCalledTimes(1);
  });
});
