// @vitest-environment jsdom
// BDD:新终端向右分屏会让组窄于下限时,改为加进最后一个终端组成为 tab —— 组不会被挤出窗口右边界。
// 见同目录 README 第 6 条。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { DockviewApi } from 'dockview-react';

vi.mock('@/notifications/notify', () => ({
  notify: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import {
  reconcileTerminalPanels,
  __resetReconcilerForTest,
  MIN_TERMINAL_SPLIT_WIDTH,
} from '@/shell/dock/DockReconciler';
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

/** 逐个新建终端(每次一轮 reconcile,与 ⌘T 连按一致)。 */
function openTerminals(api: DockviewApi, count: number, prev: TerminalSession[] = []): TerminalSession[] {
  let sessions = prev;
  for (let i = 0; i < count; i++) {
    const next = [...sessions, makeSession(`t${sessions.length}`, { createdAt: sessions.length + 1 })];
    reconcileTerminalPanels(api, { previousSessions: sessions, nextSessions: next });
    sessions = next;
  }
  return sessions;
}

describe('新终端向右分屏受组最小宽度约束', () => {
  it('连开 10 个终端:每个 grid 组都不窄于下限,组宽总和不超出 dock;放不下的终端成为最后一个终端组的 tab', () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    api.layout(1000, 600, true);
    api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    openTerminals(api, 10);

    expect(api.panels.filter((p) => p.id.startsWith('terminal-'))).toHaveLength(10);
    const groups = api.groups.filter((g) => g.api.location.type === 'grid');
    for (const g of groups) expect(g.api.width).toBeGreaterThanOrEqual(MIN_TERMINAL_SPLIT_WIDTH);
    expect(groups.reduce((sum, g) => sum + g.api.width, 0)).toBeLessThanOrEqual(1000);
    // 1000 / 160 → 最多 6 组(Editor + 5 个终端组);其余终端以 tab 加入最后一个终端组。
    expect(groups.length).toBe(Math.floor(1000 / MIN_TERMINAL_SPLIT_WIDTH));
    const last = api.getPanel('terminal-t9')!;
    expect(last.group.panels.map((p) => p.id)).toContain('terminal-t5');
  });

  it('空间够时照常向右分屏(新组在参照终端右侧)', () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    api.layout(1000, 600, true);
    openTerminals(api, 2);
    const a = api.getPanel('terminal-t0')!;
    const b = api.getPanel('terminal-t1')!;
    expect(b.group).not.toBe(a.group);
    expect(api.groups).toHaveLength(2);
  });

  it('参照终端所在列是纵向分屏:按参照组自身宽度一分为二判断', () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    api.layout(1000, 600, true);
    api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    // 右侧窄列(300px)上下两组,终端在下面那组:向右分屏会让它变成 2 × 150 < 160 → 改为 tab。
    api.addPanel({
      id: 'side',
      component: 'x',
      title: 'Side',
      position: { referencePanel: 'editor', direction: 'right' },
    });
    api.getPanel('side')!.group.api.setSize({ width: 300 });
    const sessions = openTerminals(api, 0);
    const t0 = makeSession('t0', { createdAt: 1 });
    // 先手动把首个终端放在 side 下方
    reconcileTerminalPanels(api, { previousSessions: sessions, nextSessions: [t0] });
    api.getPanel('terminal-t0')!.api.moveTo({ group: api.getPanel('side')!.group, position: 'bottom' });
    const t0Group = api.getPanel('terminal-t0')!.group;
    expect(t0Group.api.width).toBeLessThan(2 * MIN_TERMINAL_SPLIT_WIDTH);

    openTerminals(api, 1, [t0]);
    expect(api.getPanel('terminal-t1')!.group).toBe(t0Group);
  });
});
