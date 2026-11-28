// @vitest-environment jsdom
// BDD:多个 agent 终端聚在同一个组(tab),不各自向右拆一列把编辑器挤窄。见同目录 README 第 7 条。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { DockviewApi } from 'dockview-react';

vi.mock('@/notifications/notify', () => ({
  notify: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { reconcileTerminalPanels, __resetReconcilerForTest } from '@/shell/dock/DockReconciler';
import type { TerminalSession } from '@/stores/terminal.store';
import { makeSession } from '../dock-reconciler-windowid-filter/fixtures';
import { createDock } from './dock-fixtures';

beforeEach(() => {
  __resetReconcilerForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function add(api: DockviewApi, sessions: TerminalSession[], next: TerminalSession): TerminalSession[] {
  const all = [...sessions, next];
  reconcileTerminalPanels(api, { previousSessions: sessions, nextSessions: all });
  return all;
}

describe('agent 终端聚在一个组', () => {
  it('编辑器 + 用户终端时连开 4 个 agent 终端:第一个向右拆出一组,其余作为 tab 加进该组;编辑器宽度不再被均分挤窄', () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    api.layout(1600, 800, true);
    api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    // 用户终端(此时没有终端可作参照 → 落在活动的编辑器组)
    let sessions = add(api, [], makeSession('u0', { createdAt: 1 }));
    for (let i = 0; i < 4; i++) {
      sessions = add(api, sessions, makeSession(`a${i}`, { originHint: 'agent', createdAt: 10 + i }));
    }
    const agentGroup = api.getPanel('terminal-a0')!.group;
    expect(agentGroup).not.toBe(api.getPanel('editor')!.group);
    for (let i = 1; i < 4; i++) expect(api.getPanel(`terminal-a${i}`)!.group).toBe(agentGroup);
    // 只多了一组(编辑器组仍占一半),而不是每个 agent 终端一组、5 组均分(编辑器组 320px)
    expect(api.groups.filter((g) => g.api.location.type === 'grid')).toHaveLength(2);
    expect(api.getPanel('editor')!.group.api.width).toBeGreaterThanOrEqual(799);
  });

  it('用户新建终端不受影响:仍在最后一个终端右侧分屏', () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    api.layout(1600, 800, true);
    const sessions = add(api, [], makeSession('a0', { originHint: 'agent', createdAt: 1 }));
    add(api, sessions, makeSession('u1', { createdAt: 2 }));
    expect(api.getPanel('terminal-u1')!.group).not.toBe(api.getPanel('terminal-a0')!.group);
  });
});
