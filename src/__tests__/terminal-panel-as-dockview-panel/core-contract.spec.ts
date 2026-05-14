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
