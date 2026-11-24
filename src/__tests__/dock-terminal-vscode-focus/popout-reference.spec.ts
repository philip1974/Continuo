// @vitest-environment jsdom
// BDD:有终端在 popout 子窗时新建终端不抛错、落在主窗 grid。见同目录 README 第 1 条。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { DockviewApi } from 'dockview-react';

const notifyError = vi.hoisted(() => vi.fn());
vi.mock('@/notifications/notify', () => ({
  notify: { error: notifyError, info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import {
  reconcileTerminalPanels,
  __resetReconcilerForTest,
} from '@/shell/dock/DockReconciler';
import { makeSession } from '../dock-reconciler-windowid-filter/fixtures';
import { createDock, openFakePopout } from './dock-fixtures';

beforeEach(() => {
  __resetReconcilerForTest();
  notifyError.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('popout 子窗里有终端时新建终端', () => {
  it('参照面板只选 grid 中的终端:新终端落在主窗 grid,不抛错', async () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    const a = makeSession('a', { createdAt: 1 });
    const b = makeSession('b', { createdAt: 2 });
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [a, b] });
    // 把最后一个终端(b)弹到 popout 子窗 —— popout 组排在 api.panels 末尾。
    await openFakePopout(dock, 'terminal-b');
    expect(api.getPanel('terminal-b')?.api.location.type).toBe('popout');

    const c = makeSession('c', { createdAt: 3 });
    expect(() =>
      reconcileTerminalPanels(api, { previousSessions: [a, b], nextSessions: [a, b, c] }),
    ).not.toThrow();
    const panel = api.getPanel('terminal-c');
    expect(panel).toBeDefined();
    expect(panel?.api.location.type).toBe('grid');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('全部终端都在 popout、活动组是 popout:新终端落在主窗可见的 grid 组,不抛错', async () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    const a = makeSession('a', { createdAt: 1 });
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [a] });
    await openFakePopout(dock, 'terminal-a');
    expect(api.activeGroup?.api.location.type).toBe('popout');

    const b = makeSession('b', { createdAt: 2 });
    expect(() =>
      reconcileTerminalPanels(api, { previousSessions: [a], nextSessions: [a, b] }),
    ).not.toThrow();
    const panel = api.getPanel('terminal-b');
    expect(panel?.api.location.type).toBe('grid');
    expect(panel?.group).toBe(api.getPanel('editor')?.group);
  });

  it('全部终端都在 popout、活动组在 grid:落在活动组', async () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    const a = makeSession('a', { createdAt: 1 });
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [a] });
    await openFakePopout(dock, 'terminal-a');
    api.getPanel('editor')!.api.setActive();

    const b = makeSession('b', { createdAt: 2 });
    reconcileTerminalPanels(api, { previousSessions: [a], nextSessions: [a, b] });
    expect(api.getPanel('terminal-b')?.group).toBe(api.getPanel('editor')?.group);
  });

  it('addPanel 失败:notify 一次,不阻断同一轮关闭已删会话的面板与更新标题', () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    const gone = makeSession('gone', { createdAt: 1 });
    const kept = makeSession('kept', { createdAt: 2, title: 'old' });
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [gone, kept] });
    const goneClose = vi.spyOn(api.getPanel('terminal-gone')!.api, 'close');

    const realAdd = api.addPanel.bind(api);
    vi.spyOn(api, 'addPanel').mockImplementation((options) => {
      if (options.id === 'terminal-new') throw new Error('boom');
      return realAdd(options);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const renamed = { ...kept, title: 'renamed' };
    const fresh = makeSession('new', { createdAt: 3 });
    expect(() =>
      reconcileTerminalPanels(api, {
        previousSessions: [gone, kept],
        nextSessions: [renamed, fresh],
      }),
    ).not.toThrow();
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(goneClose).toHaveBeenCalled();
    expect(api.getPanel('terminal-kept')?.api.title).toBe('renamed');
  });
});
