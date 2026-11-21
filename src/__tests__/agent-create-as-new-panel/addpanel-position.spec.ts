import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import {
  reconcileTerminalPanels,
  setPendingFocus,
  __resetReconcilerForTest,
} from '@/shell/dock/DockReconciler';
import { makeSession } from '../dock-reconciler-windowid-filter/fixtures';

// race(R25):everAddedSessionIds 是模块级,测试间须 reset,否则前一用例的 session id
// 会让后一用例的同 id session 被当「重现」而不走 originHint 首次兜底聚焦。
beforeEach(() => {
  __resetReconcilerForTest();
});

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

  it('Record panels fallback 不通过 Object.values 全量物化 panels', () => {
    const valuesSpy = vi.spyOn(Object, 'values');
    const api = makeApi();
    api.panels['terminal-old'] = makePanel('terminal-old');
    api.activePanel = api.panels['terminal-old'];

    try {
      reconcileTerminalPanels(api as unknown as DockviewApi, {
        previousSessions: [makeSession('old', { createdAt: 1 })],
        nextSessions: [
          makeSession('old', { createdAt: 1 }),
          makeSession('agent-1', { originHint: 'agent', createdAt: 2 }),
        ],
      });

      expect(api.addPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          position: { referencePanel: 'terminal-old', direction: 'right' },
        }),
      );
      expect(valuesSpy).not.toHaveBeenCalled();
    } finally {
      valuesSpy.mockRestore();
    }
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

  // race(R25):user terminal 经 workspace 切换隐藏后切回再现,不得被 originHint 兜底误判为
  // 新建而抢焦点(用户可能在别的面板键入)。兜底仅对首次出现的 user terminal 生效。
  it('R25 user terminal workspace 切走再切回 → 重现不抢焦点(兜底仅首次出现)', () => {
    // close 时从 panels 移除(模拟真实 dockview),让切回走 addPanel 重现路径。
    const panels: Record<
      string,
      { id: string; api: { id: string; setActive: ReturnType<typeof vi.fn>; close: () => void; setTitle: ReturnType<typeof vi.fn> } }
    > = {};
    const api = {
      activePanel: undefined as unknown,
      getPanel: vi.fn((id: string) => panels[id]),
      addPanel: vi.fn((opts: { id: string }) => {
        const p = {
          id: opts.id,
          api: {
            id: opts.id,
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
    const s = makeSession('user-1', { originHint: 'user' });

    // 1. 首次创建 → 聚焦(originHint 兜底首次生效)
    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [],
      nextSessions: [s],
    });
    expect(panels['terminal-user-1']?.api.setActive).toHaveBeenCalledTimes(1);

    // 2. 切走 workspace → 旧 terminal 被过滤隐藏(removed → close 移除 panel)
    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [s],
      nextSessions: [],
    });
    expect(panels['terminal-user-1']).toBeUndefined();

    // 3. 切回 workspace → terminal 重现(added),不得抢焦点
    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [],
      nextSessions: [s],
    });
    expect(panels['terminal-user-1']?.api.setActive).not.toHaveBeenCalled();
  });

  // race(R25):重现的 user terminal 若有显式 pendingFocus(罕见但合法)仍应聚焦
  // (everAdded 不影响 consumePendingFocus 分支)。
  it('R25 重现 + 显式 setPendingFocus → 仍聚焦(close 移除 panel 的重现路径)', () => {
    const panels: Record<
      string,
      { id: string; api: { id: string; setActive: ReturnType<typeof vi.fn>; close: () => void; setTitle: ReturnType<typeof vi.fn> } }
    > = {};
    const api = {
      activePanel: undefined as unknown,
      getPanel: vi.fn((id: string) => panels[id]),
      addPanel: vi.fn((opts: { id: string }) => {
        const p = {
          id: opts.id,
          api: {
            id: opts.id,
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
    const s = makeSession('user-1', { originHint: 'user' });
    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [],
      nextSessions: [s],
    }); // 首次(记入 everAdded)
    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [s],
      nextSessions: [],
    }); // 切走(close 删 panel)
    setPendingFocus('user-1'); // 切回前显式 pending
    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [],
      nextSessions: [s],
    }); // 重现 + pendingFocus 命中 → 聚焦
    expect(panels['terminal-user-1']?.api.setActive).toHaveBeenCalledTimes(1);
  });

  // race(R105):两个 terminal.create 并发 + session push 乱序。较新的 user-2 先到并聚焦,
  // 较旧的 user-1 后到(仍是首次出现)不得 originHint 兜底抢焦点——它不是快照中最新 user session。
  it('R105 迟到的较旧 user session(非快照最新)不抢焦点', () => {
    const api = makeApi();
    api.panels['terminal-old'] = makePanel('terminal-old');
    api.activePanel = api.panels['terminal-old'];

    // 第一轮:较新的 user-2(createdAt=20)先到 → 聚焦
    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [makeSession('old', { createdAt: 1 })],
      nextSessions: [
        makeSession('old', { createdAt: 1 }),
        makeSession('user-2', { originHint: 'user', createdAt: 20 }),
      ],
    });
    expect(api.panels['terminal-user-2']?.api.setActive).toHaveBeenCalledTimes(1);

    // 第二轮:较旧的 user-1(createdAt=10)乱序后到。它首次出现,但快照中 user-2(20)更新
    // → user-1 不是最新 user session → 不抢焦点(否则键盘输入落到较旧 PTY)。
    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [
        makeSession('old', { createdAt: 1 }),
        makeSession('user-2', { originHint: 'user', createdAt: 20 }),
      ],
      nextSessions: [
        makeSession('old', { createdAt: 1 }),
        makeSession('user-2', { originHint: 'user', createdAt: 20 }),
        makeSession('user-1', { originHint: 'user', createdAt: 10 }),
      ],
    });
    expect(api.panels['terminal-user-1']?.api.setActive).not.toHaveBeenCalled();
    // user-1 不抢焦点 → reconciler 把焦点恢复回先前 active 的 user-2(restore 机制再调一次
    // setActive),即较新的 user-2 始终保持聚焦,不被迟到的较旧 user-1 覆盖。
    expect(api.panels['terminal-user-2']?.api.setActive).toHaveBeenCalled();
  });

  // race(R105):较新的 user session 后到(乱序)仍应聚焦——它是快照中最新 user session。
  it('R105 后到的较新 user session(快照最新)正常聚焦', () => {
    const api = makeApi();
    api.panels['terminal-old'] = makePanel('terminal-old');
    api.activePanel = api.panels['terminal-old'];

    // 较旧 user-1(10)先到 → 聚焦
    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [makeSession('old', { createdAt: 1 })],
      nextSessions: [
        makeSession('old', { createdAt: 1 }),
        makeSession('user-1', { originHint: 'user', createdAt: 10 }),
      ],
    });
    expect(api.panels['terminal-user-1']?.api.setActive).toHaveBeenCalledTimes(1);

    // 较新 user-2(20)后到 = 快照最新 user session → 聚焦(last create wins)
    reconcileTerminalPanels(api as unknown as DockviewApi, {
      previousSessions: [
        makeSession('old', { createdAt: 1 }),
        makeSession('user-1', { originHint: 'user', createdAt: 10 }),
      ],
      nextSessions: [
        makeSession('old', { createdAt: 1 }),
        makeSession('user-1', { originHint: 'user', createdAt: 10 }),
        makeSession('user-2', { originHint: 'user', createdAt: 20 }),
      ],
    });
    expect(api.panels['terminal-user-2']?.api.setActive).toHaveBeenCalledTimes(1);
  });
});
