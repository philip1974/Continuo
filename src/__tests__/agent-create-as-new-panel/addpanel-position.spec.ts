import { describe, expect, it, vi } from 'vitest';
import { reconcileTerminalPanels } from '@/shell/dock/DockReconciler';

type Session = {
  id: string;
  title: string;
  cwd: string;
  originHint: 'user' | 'agent';
  createdAt: number;
};

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    cwd: '/repo',
    originHint: 'user',
    createdAt: 1,
    ...over,
  };
}

function makePanel(id: string) {
  return {
    id,
    api: {
      id,
      setActive: vi.fn(),
      close: vi.fn(),
      setTitle: vi.fn(),
    },
  };
}

function makeApi() {
  const panels: Record<string, ReturnType<typeof makePanel>> = {};
  return {
    activePanel: undefined as ReturnType<typeof makePanel> | undefined,
    getPanel: vi.fn((id: string) => panels[id]),
    addPanel: vi.fn((opts: { id: string }) => {
      const panel = makePanel(opts.id);
      panels[opts.id] = panel;
      return panel;
    }),
    panels,
  };
}

describe('agent create as new dockview panel', () => {
  it("agent session → addPanel direction='right',不 setActive", () => {
    const api = makeApi();
    api.panels['terminal-old'] = makePanel('terminal-old');

    reconcileTerminalPanels(api, {
      previousSessions: [session('old', { createdAt: 1 })],
      nextSessions: [
        session('old', { createdAt: 1 }),
        session('agent-1', {
          originHint: 'agent',
          createdAt: 2,
        }),
      ],
    });

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'terminal-agent-1',
        position: {
          referencePanel: 'terminal-old',
          direction: 'right',
        },
        inactive: true,
      }),
    );
    expect(api.panels['terminal-agent-1']?.api.setActive).not.toHaveBeenCalled();
  });

  it('user path: pendingFocusSessionIdRef 命中 → addPanel 后 setActive,并清空 pendingFocus', () => {
    const api = makeApi();
    const pendingFocusSessionIdRef = { current: 'user-1' };

    reconcileTerminalPanels(api, {
      previousSessions: [],
      nextSessions: [session('user-1', { originHint: 'user' })],
      pendingFocusSessionIdRef,
    });

    expect(api.panels['terminal-user-1']?.api.setActive).toHaveBeenCalledTimes(1);
    expect(pendingFocusSessionIdRef.current).toBeNull();
  });

  it('batch add: 首次 hydrate 按 createdAt 升序逐个 add;首个默认位置,后续 reference 前一个', () => {
    const api = makeApi();

    reconcileTerminalPanels(api, {
      previousSessions: [],
      nextSessions: [
        session('third', { createdAt: 30 }),
        session('first', { createdAt: 10 }),
        session('second', { createdAt: 20 }),
      ],
    });

    expect(api.addPanel.mock.calls.map((call) => call[0].id)).toEqual([
      'terminal-first',
      'terminal-second',
      'terminal-third',
    ]);
    expect(api.addPanel.mock.calls[0]![0]).not.toHaveProperty('position');
    expect(api.addPanel.mock.calls[1]![0]).toEqual(
      expect.objectContaining({
        position: { referencePanel: 'terminal-first', direction: 'right' },
      }),
    );
    expect(api.addPanel.mock.calls[2]![0]).toEqual(
      expect.objectContaining({
        position: { referencePanel: 'terminal-second', direction: 'right' },
      }),
    );
  });
});
