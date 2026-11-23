// @vitest-environment jsdom
// 复审 r3 term#1:终端首个权威快照(hydrate 语义)与 Splash 放行须与 listSessions / workspace 恢复的
// 完成顺序无关:
//  - workspace 先恢复、listSessions 仍在途 → 不得把「尚无快照」当成空的首快照置 hydrated
//  - listSessions 先返回、workspace root 尚未恢复(null)→ 首轮可见过滤等 workspace hydrated,不把存量
//    workspace 终端先滤掉、恢复后再当普通新增抢焦
//  - 初始拉取失败 → 只放行 Splash 屏障;之后首个有效广播仍按 hydrate 处理(存量 user 终端不抢焦)
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import type { DockviewApi } from 'dockview-react';
import { TerminalSessionsSync } from '../../shell/dock/TerminalSessionsSync';
import { __resetReconcilerForTest, useDockReconciler } from '../../shell/dock/DockReconciler';
import { useTerminalStore, type TerminalSession } from '../../stores/terminal.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

const mocks = vi.hoisted(() => {
  let onChanged: ((sessions: unknown) => void) | null = null;
  return {
    listSessions: vi.fn(),
    onSessionsChanged: vi.fn((cb: (sessions: unknown) => void) => {
      onChanged = cb;
      return () => {};
    }),
    emit: (sessions: unknown) => onChanged?.(sessions),
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
vi.mock('@/notifications/notify', () => ({ notify: { error: vi.fn() } }));

/** 恢复开始时刻:createdAt 早于它的 session 是存量(hydrate 时不抢焦)。 */
const RESTORE_STARTED_AT = 1000;

function session(id: string, workspaceRoot = '/proj'): TerminalSession {
  return {
    id,
    title: id,
    cwd: workspaceRoot,
    originHint: 'user',
    createdAt: 10,
    exitCode: null,
    ownerWindowId: 1,
    workspaceRoot,
  };
}

type Panel = { id: string; api: { id: string; setActive: ReturnType<typeof vi.fn>; close: () => void; setTitle: ReturnType<typeof vi.fn> } };

function makeApi() {
  const panels: Record<string, Panel> = {};
  const api = {
    activePanel: undefined as Panel | undefined,
    getPanel: vi.fn((id: string) => panels[id]),
    addPanel: vi.fn((opts: { id: string }) => {
      const p: Panel = {
        id: opts.id,
        api: { id: opts.id, setActive: vi.fn(), close: () => delete panels[opts.id], setTitle: vi.fn() },
      };
      panels[opts.id] = p;
      return p;
    }),
    byId: panels,
    // 真实 DockviewApi.panels 是数组
    get panels() {
      return Object.values(panels);
    },
  };
  return api;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mount() {
  const api = makeApi();
  const onHydrated = vi.fn();
  renderHook(() =>
    useDockReconciler(api as unknown as DockviewApi, RESTORE_STARTED_AT, onHydrated),
  );
  render(React.createElement(TerminalSessionsSync));
  return { api, onHydrated };
}

/** 模拟 initExplorerPersistence:先 setRoot 恢复 root,再 markHydrated。 */
function restoreWorkspace(root: string) {
  useWorkspaceStore.getState().setRoot(root);
  useWorkspaceStore.getState().markHydrated();
}

beforeEach(() => {
  __resetReconcilerForTest();
  mocks.listSessions.mockReset();
  useTerminalStore.setState({ sessions: [], hydrated: false, settled: false });
  useWorkspaceStore.setState({ root: null, hydrated: false, rootRestored: false });
});
afterEach(() => cleanup());

describe('终端首个快照与 workspace 恢复的完成顺序', () => {
  it('workspace 先恢复、listSessions 在途 → 不提前 hydrated;快照到达后存量终端按 hydrate 建且不抢焦', async () => {
    const list = deferred<unknown>();
    mocks.listSessions.mockReturnValue(list.promise);
    const { api, onHydrated } = mount();

    act(() => restoreWorkspace('/proj'));
    expect(useTerminalStore.getState().hydrated).toBe(false);
    expect(onHydrated).not.toHaveBeenCalled();

    await act(async () => {
      list.resolve({ ok: true, data: { sessions: [session('t1')] } });
    });
    expect(api.byId['terminal-t1']).toBeDefined();
    expect(api.byId['terminal-t1']?.api.setActive).not.toHaveBeenCalled();
    expect(onHydrated).toHaveBeenCalledTimes(1);
  });

  it('listSessions 先返回、workspace root 尚未恢复 → 等 workspace hydrated 再做首轮过滤,存量终端不抢焦', async () => {
    mocks.listSessions.mockResolvedValue({ ok: true, data: { sessions: [session('t1')] } });
    const { api, onHydrated } = mount();
    await act(async () => {});
    expect(useTerminalStore.getState().hydrated).toBe(false);
    expect(onHydrated).not.toHaveBeenCalled();

    act(() => restoreWorkspace('/proj'));
    expect(useTerminalStore.getState().hydrated).toBe(true);
    expect(api.byId['terminal-t1']).toBeDefined();
    expect(api.byId['terminal-t1']?.api.setActive).not.toHaveBeenCalled();
    expect(onHydrated).toHaveBeenCalledTimes(1);
  });

  it('初始拉取失败 → 只放行 Splash;之后恢复的首个有效广播仍按 hydrate 处理(不抢焦)', async () => {
    mocks.listSessions.mockRejectedValue(new Error('ipc down'));
    act(() => restoreWorkspace('/proj'));
    const { api, onHydrated } = mount();
    await act(async () => {});
    expect(onHydrated).toHaveBeenCalledTimes(1);
    expect(useTerminalStore.getState().hydrated).toBe(false);

    act(() => mocks.emit([session('t1')]));
    expect(useTerminalStore.getState().hydrated).toBe(true);
    expect(api.byId['terminal-t1']).toBeDefined();
    expect(api.byId['terminal-t1']?.api.setActive).not.toHaveBeenCalled();
  });

  it('root 已恢复、编辑器 tab 仍在读盘(未 hydrated)→ 不等 tab 恢复即完成首轮过滤与 Splash 放行', async () => {
    mocks.listSessions.mockResolvedValue({ ok: true, data: { sessions: [session('t1')] } });
    const { api, onHydrated } = mount();
    await act(async () => {});

    act(() => {
      useWorkspaceStore.getState().setRoot('/proj');
      useWorkspaceStore.getState().markRootRestored();
    });
    expect(useWorkspaceStore.getState().hydrated).toBe(false);
    expect(useTerminalStore.getState().hydrated).toBe(true);
    expect(api.byId['terminal-t1']).toBeDefined();
    expect(api.byId['terminal-t1']?.api.setActive).not.toHaveBeenCalled();
    expect(onHydrated).toHaveBeenCalledTimes(1);
  });
});
