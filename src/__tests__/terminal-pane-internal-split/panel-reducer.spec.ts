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
});
