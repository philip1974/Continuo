import { describe, expect, it } from 'vitest';
import {
  defaultPersistedState,
  panelReducer,
  serializeTabsStateForPersistence,
  type PanelState,
} from '../../panels/Terminal/panelReducer';

function twoTabState(): PanelState {
  return {
    hydrated: true,
    activeTabId: 'tab-1',
    tabs: [
      {
        id: 'tab-1',
        title: 'One',
        primaryLeafId: 'leaf-a',
        activeLeafId: 'leaf-a',
        paneTreeVersion: 1,
        paneTree: { kind: 'leaf', id: 'leaf-a', ptyId: 'pty-a', cwd: '/a' },
      },
      {
        id: 'tab-2',
        title: 'Two',
        primaryLeafId: 'leaf-b',
        activeLeafId: 'leaf-b',
        paneTreeVersion: 1,
        paneTree: { kind: 'leaf', id: 'leaf-b', ptyId: 'pty-b', cwd: '/b' },
      },
    ],
  };
}

describe('panelReducer', () => {
  it('default persisted state is a single leaf tab', () => {
    expect(defaultPersistedState('/repo')).toEqual({
      activeTabId: 'tab-default',
      tabs: [
        {
          id: 'tab-default',
          title: 'Terminal',
          primaryLeafId: 'leaf-default',
          paneTreeVersion: 1,
          paneTree: { kind: 'leaf', id: 'leaf-default', cwd: '/repo' },
        },
      ],
    });
  });

  it('hydrates empty persisted state without spawn effects', () => {
    const result = panelReducer(
      { tabs: [], activeTabId: null, hydrated: false },
      { type: 'HYDRATE', persisted: { tabs: [], activeTabId: '' } },
    );

    expect(result.state).toEqual({ tabs: [], activeTabId: null, hydrated: true });
    expect(result.effects).toEqual([]);
  });

  it('adds a tab and makes it active', () => {
    const result = panelReducer(twoTabState(), {
      type: 'ADD_TAB',
      tabId: 'tab-3',
      primaryLeafId: 'leaf-c',
      title: 'Three',
      cwd: '/c',
    });

    expect(result.state.activeTabId).toBe('tab-3');
    expect(result.state.tabs).toHaveLength(3);
    expect(result.effects).toEqual([
      {
        type: 'ENQUEUE_SPAWN',
        tabId: 'tab-3',
        leafId: 'leaf-c',
        cwd: '/c',
        scoped: true,
        reason: 'addTab',
      },
    ]);
  });

  it('closes inactive tab without changing active tab', () => {
    const result = panelReducer(twoTabState(), { type: 'CLOSE_TAB', tabId: 'tab-2' });

    expect(result.state.activeTabId).toBe('tab-1');
    expect(result.effects).toEqual([
      { type: 'TAB_CLOSED_AUTO', tabId: 'tab-2', ptyIds: ['pty-b'] },
    ]);
  });

  it('closes active tab and selects a remaining tab', () => {
    const result = panelReducer(twoTabState(), { type: 'CLOSE_TAB', tabId: 'tab-1' });

    expect(result.state.activeTabId).toBe('tab-2');
    expect(result.state.tabs.map((t) => t.id)).toEqual(['tab-2']);
  });

  it('close tab emits PANEL_EMPTY when it removes the final tab', () => {
    const state = { ...twoTabState(), tabs: [twoTabState().tabs[0]!], activeTabId: 'tab-1' };
    const result = panelReducer(state, { type: 'CLOSE_TAB', tabId: 'tab-1' });

    expect(result.effects.map((effect) => effect.type)).toEqual([
      'TAB_CLOSED_AUTO',
      'PANEL_EMPTY',
    ]);
    expect(result.state.activeTabId).toBeNull();
  });

  it('upgrades pane split effect with tab id', () => {
    const result = panelReducer(twoTabState(), {
      type: 'PANE_ACTION',
      tabId: 'tab-1',
      action: {
        type: 'SPLIT',
        leafId: 'leaf-a',
        dir: 'horizontal',
        newLeafId: 'leaf-new',
      },
    });

    expect(result.effects).toEqual([
      {
        type: 'ENQUEUE_SPAWN',
        tabId: 'tab-1',
        leafId: 'leaf-new',
        cwd: '/a',
        scoped: true,
        reason: 'split',
      },
    ]);
  });

  it('serializes panel state with volatile PTY fields stripped', () => {
    expect(serializeTabsStateForPersistence(twoTabState())).toEqual({
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          title: 'One',
          primaryLeafId: 'leaf-a',
          paneTreeVersion: 1,
          paneTree: { kind: 'leaf', id: 'leaf-a', cwd: '/a' },
        },
        {
          id: 'tab-2',
          title: 'Two',
          primaryLeafId: 'leaf-b',
          paneTreeVersion: 1,
          paneTree: { kind: 'leaf', id: 'leaf-b', cwd: '/b' },
        },
      ],
    });
  });

  // ── folder isolation:workspaceRoot 字段在 reducer 各路径上的传递 ──

  it('ADD_TAB 带 workspaceRoot → tab 与 ENQUEUE_SPAWN 都带 workspaceRoot', () => {
    const result = panelReducer(
      { tabs: [], activeTabId: null, hydrated: true },
      {
        type: 'ADD_TAB',
        tabId: 'tab-w',
        primaryLeafId: 'leaf-w',
        title: 'W',
        cwd: '/proj-a',
        workspaceRoot: '/proj-a',
      },
    );
    expect(result.state.tabs[0]!.workspaceRoot).toBe('/proj-a');
    const enqueue = result.effects.find((e) => e.type === 'ENQUEUE_SPAWN');
    expect(enqueue && enqueue.type === 'ENQUEUE_SPAWN' && enqueue.workspaceRoot).toBe(
      '/proj-a',
    );
  });

  it('ADD_TAB 不传 workspaceRoot → tab/effect 都不带该字段(全局)', () => {
    const result = panelReducer(
      { tabs: [], activeTabId: null, hydrated: true },
      {
        type: 'ADD_TAB',
        tabId: 'tab-g',
        primaryLeafId: 'leaf-g',
        title: 'G',
        cwd: '/g',
      },
    );
    expect('workspaceRoot' in result.state.tabs[0]!).toBe(false);
    const enqueue = result.effects.find((e) => e.type === 'ENQUEUE_SPAWN');
    expect(enqueue && enqueue.type === 'ENQUEUE_SPAWN' && 'workspaceRoot' in enqueue).toBe(
      false,
    );
  });

  it('HYDRATE 持久化 tab 带 workspaceRoot → hydrate 出的 tab + ENQUEUE_SPAWN 都带', () => {
    const result = panelReducer(
      { tabs: [], activeTabId: null, hydrated: false },
      {
        type: 'HYDRATE',
        persisted: {
          activeTabId: 'tab-h',
          tabs: [
            {
              id: 'tab-h',
              title: 'H',
              primaryLeafId: 'leaf-h',
              paneTreeVersion: 1,
              paneTree: { kind: 'leaf', id: 'leaf-h', cwd: '/proj-b' },
              workspaceRoot: '/proj-b',
            },
          ],
        },
      },
    );
    expect(result.state.tabs[0]!.workspaceRoot).toBe('/proj-b');
    const enqueue = result.effects[0];
    expect(enqueue?.type).toBe('ENQUEUE_SPAWN');
    expect(enqueue && enqueue.type === 'ENQUEUE_SPAWN' && enqueue.workspaceRoot).toBe(
      '/proj-b',
    );
  });

  it('serializeTabsStateForPersistence 圆 trip workspaceRoot', () => {
    const state: PanelState = {
      hydrated: true,
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          title: 'X',
          primaryLeafId: 'leaf-1',
          activeLeafId: 'leaf-1',
          paneTreeVersion: 1,
          paneTree: { kind: 'leaf', id: 'leaf-1', cwd: '/x', ptyId: 'pty-1' },
          workspaceRoot: '/x',
        },
      ],
    };
    const ser = serializeTabsStateForPersistence(state);
    expect(ser.tabs[0]!.workspaceRoot).toBe('/x');
  });

  it('PANE_ACTION SPLIT 继承 tab.workspaceRoot 到新 leaf 的 ENQUEUE_SPAWN', () => {
    const base = twoTabState();
    base.tabs[0] = { ...base.tabs[0]!, workspaceRoot: '/proj-a' };
    const result = panelReducer(base, {
      type: 'PANE_ACTION',
      tabId: 'tab-1',
      action: {
        type: 'SPLIT',
        leafId: 'leaf-a',
        dir: 'vertical',
        newLeafId: 'leaf-new',
      },
    });
    const enqueue = result.effects.find((e) => e.type === 'ENQUEUE_SPAWN');
    expect(enqueue && enqueue.type === 'ENQUEUE_SPAWN' && enqueue.workspaceRoot).toBe(
      '/proj-a',
    );
  });
});
