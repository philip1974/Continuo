// @vitest-environment jsdom
// BDD:关掉活动组 / popout 子窗后,激活最近使用的组(而非 dockview 默认的最早的组);popout 收回的面板获焦。
// 见同目录 README 第 3 条。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Orientation, type DockviewApi } from 'dockview-react';
import { trackGroupMru } from '@/shell/dock/group-mru';
import {
  registerTerminalPanelHandles,
  __resetTerminalPanelHandlesForTest,
} from '@/panels/Terminal/terminal-panel-handles';
import { createDock, openFakePopout } from './dock-fixtures';

const noop = () => {};
/** 聚焦延到 microtask(等 dockview 本轮同步收尾),断言前让它跑完。 */
const flushMicrotasks = () => new Promise<void>((r) => queueMicrotask(r));
function registerFocusSpy(panelId: string) {
  const focus = vi.fn();
  registerTerminalPanelHandles(panelId, { focus, openSearch: noop, clear: noop, scroll: noop, readText: () => '', readViewport: () => null });
  return focus;
}

/** 三个并排的组:g(a) | g(b) | g(c)。 */
function threeColumns(api: DockviewApi) {
  api.addPanel({ id: 'a', component: 'terminal', title: 'a' });
  api.addPanel({ id: 'b', component: 'terminal', title: 'b', position: { referencePanel: 'a', direction: 'right' } });
  api.addPanel({ id: 'c', component: 'terminal', title: 'c', position: { referencePanel: 'b', direction: 'right' } });
}

beforeEach(() => __resetTerminalPanelHandlesForTest());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('组 MRU:移除活动组后激活最近使用的组', () => {
  it('a → c → b 依次激活,关掉 b 所在组 → 激活 c(最近使用),终端 c 获焦', async () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    threeColumns(api);
    const tracker = trackGroupMru(api);
    const focusC = registerFocusSpy('c');
    api.getPanel('a')!.api.setActive();
    api.getPanel('c')!.api.setActive();
    api.getPanel('b')!.api.setActive();

    api.removePanel(api.getPanel('b')!);
    await flushMicrotasks();

    expect(api.activePanel?.id).toBe('c');
    expect(focusC).toHaveBeenCalled();
    tracker.dispose();
  });

  it('移除的不是活动组 → 不改变活动面板', () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    threeColumns(api);
    const tracker = trackGroupMru(api);
    api.getPanel('c')!.api.setActive();
    api.getPanel('a')!.api.setActive();

    api.removePanel(api.getPanel('b')!);

    expect(api.activePanel?.id).toBe('a');
    tracker.dispose();
  });

  it('popout 子窗关闭:收回主窗的面板成为活动面板并获焦', async () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    threeColumns(api);
    const tracker = trackGroupMru(api);
    const focusC = registerFocusSpy('c');
    api.getPanel('a')!.api.setActive();
    const popout = await openFakePopout(dock, 'c');
    api.getPanel('c')!.api.setActive();
    expect(api.getPanel('c')!.api.location.type).toBe('popout');
    focusC.mockClear();

    popout.close();
    await flushMicrotasks();

    const c = api.getPanel('c')!;
    expect(c.api.location.type).toBe('grid');
    expect(api.activePanel?.id).toBe('c');
    expect(focusC).toHaveBeenCalled();
    tracker.dispose();
  });

  // dockview 弹出时把 popout 组设为活动组,活动面板仍是同一对象 → 不派发 onDidActivePanelChange;收回仍须获焦。
  it('弹出的就是当前活动面板(弹出后不再切换):关子窗后收回的面板成为活动面板并获焦', async () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    threeColumns(api);
    const tracker = trackGroupMru(api);
    const focusC = registerFocusSpy('c');
    api.getPanel('c')!.api.setActive();
    const popout = await openFakePopout(dock, 'c');
    expect(api.getPanel('c')!.api.location.type).toBe('popout');
    expect(api.activePanel?.id).toBe('c');
    focusC.mockClear();

    popout.close();
    await flushMicrotasks();

    expect(api.getPanel('c')!.api.location.type).toBe('grid');
    expect(api.activePanel?.id).toBe('c');
    expect(focusC).toHaveBeenCalled();
    tracker.dispose();
  });

  // 从多面板组里弹出活动面板:dockview 在 movingLock 内把面板挪进新 popout 组(openPanel 顺带把它设为活动组,事件被
  // movingLock 吞掉),随后 doSetGroupAndPanelActive 因已是活动组直接返回 → 不派发任何活动组 / 活动面板事件。
  // 此前记不到 popout 组的活动面板,关子窗后收回的面板不获焦,主窗焦点留在 body(真机:点子窗红绿灯关闭同样)。
  it('从多面板组里弹出活动面板:关子窗后收回的面板获焦', async () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    api.addPanel({ id: 'a', component: 'terminal', title: 'a' });
    api.addPanel({ id: 'b', component: 'terminal', title: 'b', position: { referencePanel: 'a', direction: 'right' } });
    api.addPanel({ id: 'c', component: 'terminal', title: 'c', position: { referencePanel: 'a', direction: 'within' } });
    const tracker = trackGroupMru(api);
    const focusC = registerFocusSpy('c');
    api.getPanel('c')!.api.setActive();
    expect(api.getPanel('c')!.group).toBe(api.getPanel('a')!.group);
    const popout = await openFakePopout(dock, 'c');
    expect(api.getPanel('c')!.api.location.type).toBe('popout');
    focusC.mockClear();

    popout.close();
    await flushMicrotasks();

    expect(api.getPanel('c')!.api.location.type).toBe('grid');
    expect(api.activePanel?.id).toBe('c');
    expect(focusC).toHaveBeenCalled();
    tracker.dispose();
  });

  it('拖动组里最后一个 tab 进另一组:dockview 自己激活目标组,键盘焦点不被送进第三个终端', async () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    threeColumns(api);
    const tracker = trackGroupMru(api);
    const focusA = registerFocusSpy('a');
    const focusC = registerFocusSpy('c');
    api.getPanel('a')!.api.setActive();
    api.getPanel('c')!.api.setActive();
    api.getPanel('b')!.api.setActive();
    focusA.mockClear();
    focusC.mockClear();

    // 拖 tab 落到另一组中央走的就是 moveGroupOrPanel(源组变空 → doRemoveGroup(skipActive),照常派发 onDidRemoveGroup)。
    api.getPanel('b')!.api.moveTo({ group: api.getPanel('a')!.group, position: 'center' });
    await flushMicrotasks();

    expect(api.activePanel?.id).toBe('b');
    expect(api.getPanel('b')!.group).toBe(api.getPanel('a')!.group);
    expect(focusC).not.toHaveBeenCalled();
    expect(focusA).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it('只在同一窗口内回落:主窗关组时跳过 MRU 里的 popout 组,激活主窗最近使用的组', async () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    threeColumns(api);
    const tracker = trackGroupMru(api);
    const focusA = registerFocusSpy('a');
    const focusC = registerFocusSpy('c');
    await openFakePopout(dock, 'c');
    api.getPanel('a')!.api.setActive();
    api.getPanel('c')!.api.setActive();
    api.getPanel('b')!.api.setActive();
    expect(api.getPanel('c')!.api.location.type).toBe('popout');
    focusC.mockClear();

    api.removePanel(api.getPanel('b')!);
    await flushMicrotasks();

    expect(api.activePanel?.id).toBe('a');
    expect(focusA).toHaveBeenCalled();
    expect(focusC).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it('popout 子窗里的组被移除、同窗无其它组 → 不跳到另一个 popout 子窗', async () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    threeColumns(api);
    const tracker = trackGroupMru(api);
    const focusB = registerFocusSpy('b');
    await openFakePopout(dock, 'b');
    await openFakePopout(dock, 'c');
    api.getPanel('a')!.api.setActive();
    api.getPanel('b')!.api.setActive();
    api.getPanel('c')!.api.setActive();
    focusB.mockClear();

    api.removePanel(api.getPanel('c')!);
    await flushMicrotasks();

    expect(api.activePanel?.id).not.toBe('b');
    expect(focusB).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it('dispose 后不再干预(回到 dockview 默认)', () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    threeColumns(api);
    const tracker = trackGroupMru(api);
    api.getPanel('a')!.api.setActive();
    api.getPanel('c')!.api.setActive();
    api.getPanel('b')!.api.setActive();
    tracker.dispose();

    api.removePanel(api.getPanel('b')!);

    expect(api.activePanel?.id).toBe('a');
  });
});

describe('组内面板 MRU:活动面板总是组里最近使用的(关掉新面板回到它)', () => {
  /** 一组三个 tab:editor(活动)、search、other —— 活动面板不在最后。 */
  function restoredLayout(api: DockviewApi) {
    api.fromJSON({
      grid: {
        root: {
          type: 'branch',
          data: [{ type: 'leaf', data: { id: 'g1', views: ['editor', 'search', 'other'], activeView: 'editor' }, size: 800 }],
          size: 600,
        },
        width: 800,
        height: 600,
        orientation: Orientation.HORIZONTAL,
      },
      panels: {
        editor: { id: 'editor', contentComponent: 'x', title: 'editor' },
        search: { id: 'search', contentComponent: 'x', title: 'search' },
        other: { id: 'other', contentComponent: 'x', title: 'other' },
      },
      activeGroup: 'g1',
    });
  }

  it('fromJSON 恢复后(未点过 tab)新建面板再关掉 → 回到恢复时的活动面板,不是组里最后一个 tab', () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    restoredLayout(api);
    expect(api.activePanel?.id).toBe('editor');
    const tracker = trackGroupMru(api);
    api.addPanel({ id: 'term', component: 'x', title: 'term', position: { referencePanel: 'editor', direction: 'within' } });
    expect(api.activePanel?.id).toBe('term');

    api.removePanel(api.getPanel('term')!);

    expect(api.activePanel?.id).toBe('editor');
    tracker.dispose();
  });

  it('跟踪期间在后台加入的面板(不激活,如 agent 建的终端)不排到活动面板前面', () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    api.addPanel({ id: 'a', component: 'x', title: 'a' });
    api.addPanel({ id: 'b', component: 'x', title: 'b', position: { referencePanel: 'a', direction: 'within' } });
    const tracker = trackGroupMru(api);
    api.getPanel('a')!.api.setActive();
    api.addPanel({ id: 'bg', component: 'x', title: 'bg', inactive: true, position: { referencePanel: 'a', direction: 'within' } });
    api.addPanel({ id: 'c', component: 'x', title: 'c', position: { referencePanel: 'a', direction: 'within' } });

    api.removePanel(api.getPanel('c')!);

    expect(api.activePanel?.id).toBe('a');
    tracker.dispose();
  });
});
