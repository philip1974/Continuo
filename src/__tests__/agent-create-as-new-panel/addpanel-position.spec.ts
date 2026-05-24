import { describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import {
  reconcileTerminalPanels,
  setPendingFocus,
} from '@/shell/dock/DockReconciler';
import type { TerminalSession } from '@/stores/terminal.store';
import { makeSession } from '../dock-reconciler-windowid-filter/fixtures';

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
  const api = {
    activePanel: undefined as ReturnType<typeof makePanel> | undefined,
    getPanel: vi.fn((id: string) => panels[id]),
    addPanel: vi.fn((opts: { id: string }) => {
      const panel = makePanel(opts.id);
      panels[opts.id] = panel;
      // dockview 默认行为:新 addPanel 后 panel 变 active。
      api.activePanel = panel;
      return panel;
    }),
    panels,
  };
  return api;
}

describe('agent create as new dockview panel', () => {
  it("agent session → addPanel direction='right',new panel 不 setActive,原 active panel focus 被恢复", () => {
    const api = makeApi();
    api.panels['terminal-old'] = makePanel('terminal-old');
    api.activePanel = api.panels['terminal-old']; // 原 active panel

    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [makeSession('old', { createdAt: 1 })],
      nextSessions: [
        makeSession('old', { createdAt: 1 }),
        makeSession('agent-1', {
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
      }),
    );
    // 不能传 inactive: true(dockview inactive 让 xterm 渲染不可见)
    expect(api.addPanel.mock.calls[0]![0]).not.toHaveProperty('inactive');
    // agent 新 panel 自身不显式 setActive
    expect(api.panels['terminal-agent-1']?.api.setActive).not.toHaveBeenCalled();
    // 原 active panel(terminal-old)被显式 setActive 回去,实现"agent 不抢 focus"
    expect(api.panels['terminal-old']?.api.setActive).toHaveBeenCalledTimes(1);
  });

  it('user path: setPendingFocus 命中 → addPanel 后 setActive,并清空 pendingFocus', () => {
    const api = makeApi();
    setPendingFocus('user-1');

    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [],
      nextSessions: [makeSession('user-1', { originHint: 'user' })],
    });

    expect(api.panels['terminal-user-1']?.api.setActive).toHaveBeenCalledTimes(1);
  });

  it("增量 user origin 新 session 即便没 setPendingFocus 也 setActive(IPC-vs-RPC 时序无关兜底)", () => {
    const api = makeApi();
    api.panels['terminal-old'] = makePanel('terminal-old');
    api.activePanel = api.panels['terminal-old'];

    // user 路径:terminal.create RPC 返回前 sessions-changed IPC 先到 →
    // reconciler 跑时 pendingFocus 还没 set。此时仍应让新 user session 抢 focus。
    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [makeSession('old', { createdAt: 1 })],
      nextSessions: [
        makeSession('old', { createdAt: 1 }),
        makeSession('user-2', { originHint: 'user', createdAt: 2 }),
      ],
    });

    expect(api.panels['terminal-user-2']?.api.setActive).toHaveBeenCalledTimes(1);
    // 原 active panel 不再被 setActive 回去 — user 主动 create 就是要切到新 tab
    expect(api.panels['terminal-old']?.api.setActive).not.toHaveBeenCalled();
  });

  it('user first create(prev=空 + 1 个 user session)也 setActive,符合 ActionHeader + 按钮路径直觉', () => {
    const api = makeApi();
    // 首次 create 场景:启动后用户还没创任何 terminal,prev=[]。
    // ActionHeader + 按钮触发 coApi.terminal.create → SessionsSync ingest →
    // reconciler 进 user-1。这是真 user-create 不是 hydrate(terminal session
    // 不跨 app restart 持久化,startup listSessions 永远返空数组)。
    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [],
      nextSessions: [makeSession('user-1', { originHint: 'user' })],
    });

    expect(api.panels['terminal-user-1']?.api.setActive).toHaveBeenCalledTimes(1);
  });

  it('batch add: 首次 hydrate 按 createdAt 升序逐个 add;首个默认位置,后续 reference 前一个', () => {
    const api = makeApi();

    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [],
      nextSessions: [
        makeSession('third', { createdAt: 30 }),
        makeSession('first', { createdAt: 10 }),
        makeSession('second', { createdAt: 20 }),
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
