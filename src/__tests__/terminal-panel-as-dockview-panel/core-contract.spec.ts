import { describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import type { TerminalSession } from '../../stores/terminal.store';
import {
  handleTerminalPanelRemoved,
  markPanelCloseSuppressed,
  reconcileTerminalPanels,
} from '@/shell/dock/DockReconciler';

function session(id: string, over: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id,
    title: `Terminal ${id}`,
    cwd: '/repo',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ...over,
    ownerWindowId: 1,
  };
}

function makePanel(id: string) {
  return {
    id,
    api: {
      id,
      close: vi.fn(),
      setActive: vi.fn(),
      setTitle: vi.fn(),
    },
    params: { sessionId: id.replace(/^terminal-/, '') },
  };
}

function makeApi(existing: Record<string, ReturnType<typeof makePanel>> = {}) {
  const panels = { ...existing };
  return {
    addPanel: vi.fn((opts: { id: string }) => {
      const panel = makePanel(opts.id);
      panels[opts.id] = panel;
      return panel;
    }),
    getPanel: vi.fn((id: string) => panels[id]),
    panels: Object.values(panels),
  };
}

function asRemoveApi(api: ReturnType<typeof makeApi>): Pick<DockviewApi, 'getPanel'> {
  return api as unknown as Pick<DockviewApi, 'getPanel'>;
}

describe('terminal panel reconciler core contract', () => {
  it('add: 为新增 session 调 addPanel({ id: terminal-<sid>, component: terminal }) 且同 sid 二次 add 幂等', () => {
    const api = makeApi();
    const next = [session('s1')];

    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [],
      nextSessions: next,
    });
    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: next,
      nextSessions: next,
    });

    expect(api.addPanel).toHaveBeenCalledTimes(1);
    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'terminal-s1',
        component: 'terminal',
        params: expect.objectContaining({ sessionId: 's1' }),
      }),
    );
  });

  it('构建 session lookup 时不对 prev/next 先 map 成中间数组', () => {
    const api = makeApi();
    const previousSessions = [session('old')];
    const nextSessions = [session('old'), session('new', { createdAt: 2 })];
    const mapSpy = vi.spyOn(Array.prototype, 'map');

    try {
      reconcileTerminalPanels(api as unknown as DockviewApi, {
        previousSessions,
        nextSessions,
      });
      const mapCallsOnSnapshots = mapSpy.mock.contexts.filter(
        (ctx) => ctx === previousSessions || ctx === nextSessions,
      ).length;
      expect(mapCallsOnSnapshots).toBe(0);
    } finally {
      mapSpy.mockRestore();
    }
    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'terminal-new' }),
    );
  });

  it('收集新增 sessions 时不通过 nextSessions.filter 生成中间数组', () => {
    const api = makeApi();
    const previousSessions = [session('old')];
    const nextSessions = [
      session('old'),
      session('newer', { createdAt: 3 }),
      session('newer-2', { createdAt: 2 }),
    ];
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      reconcileTerminalPanels(api as unknown as DockviewApi, {
        previousSessions,
        nextSessions,
      });
      const filterCallsOnNextSessions = filterSpy.mock.contexts.filter(
        (ctx) => ctx === nextSessions,
      ).length;
      expect(filterCallsOnNextSessions).toBe(0);
      expect(reconcileTerminalPanels.toString()).not.toContain('added.push(');
    } finally {
      filterSpy.mockRestore();
    }
    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'terminal-newer' }),
    );
    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'terminal-newer-2' }),
    );
  });

  it('无新增 session 时不预分配 added 数组', () => {
    const api = makeApi();
    const previousSessions = [session('old')];
    let lengthReads = 0;
    const nextSessions = {
      *[Symbol.iterator]() {
        yield previousSessions[0]!;
      },
      get length() {
        lengthReads += 1;
        return 1;
      },
    } as unknown as readonly TerminalSession[];

    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions,
      nextSessions,
    });

    expect(api.addPanel).not.toHaveBeenCalled();
    expect(lengthReads).toBe(0);
  });

  it('remove: store 删除 session 时通过 api.getPanel(id)?.api.close() 关闭;不存在则 no-op', () => {
    const panel = makePanel('terminal-s1');
    const api = makeApi({ 'terminal-s1': panel });

    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [session('s1'), session('missing')],
      nextSessions: [],
    });

    expect(api.getPanel).toHaveBeenCalledWith('terminal-s1');
    expect(api.getPanel).toHaveBeenCalledWith('terminal-missing');
    expect(panel.api.close).toHaveBeenCalledTimes(1);
  });

  it('reconciler 主动 close 前 markPanelCloseSuppressed;DockShell remove handler 命中 suppress 时跳过 terminal.remove', async () => {
    const panel = makePanel('terminal-s1');
    const api = makeApi({ 'terminal-s1': panel });
    const removeSession = vi.fn();

    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [session('s1')],
      nextSessions: [],
    });
    await handleTerminalPanelRemoved({
      panel,
      api: asRemoveApi(api),
      removeSession,
    });

    expect(removeSession).not.toHaveBeenCalled();
  });

  it('用户关 panel:无 suppress 且 microtask 后 getPanel(id) 仍不存在时 remove session', async () => {
    const panel = makePanel('terminal-s1');
    const api = makeApi();
    const removeSession = vi.fn();

    await handleTerminalPanelRemoved({
      panel,
      api: asRemoveApi(api),
      removeSession,
    });

    expect(removeSession).toHaveBeenCalledWith('s1');
  });

  it('move 检测: onDidRemovePanel 后 microtask 内 getPanel(id) 仍存在则视为 move,跳过 remove', async () => {
    const panel = makePanel('terminal-s1');
    const api = makeApi({ 'terminal-s1': panel });
    const removeSession = vi.fn();

    await handleTerminalPanelRemoved({
      panel,
      api: asRemoveApi(api),
      removeSession,
    });

    expect(removeSession).not.toHaveBeenCalled();
  });

  it('markPanelCloseSuppressed 可由 DockShell close handler 直接消费', () => {
    markPanelCloseSuppressed('terminal-s1');
    const panel = makePanel('terminal-s1');
    const api = makeApi();
    const removeSession = vi.fn();

    return handleTerminalPanelRemoved({ panel, api: asRemoveApi(api), removeSession }).then(() => {
      expect(removeSession).not.toHaveBeenCalled();
    });
  });
});
