import { describe, expect, it } from 'vitest';
import {
  panelReducer,
  type PanelState,
} from '../../panels/Terminal/panelReducer';

function state(): PanelState {
  return {
    hydrated: true,
    activeTabId: 'tab-1',
    tabs: [
      {
        id: 'tab-1',
        title: 'One',
        primaryLeafId: 'leaf-a',
        activeLeafId: 'leaf-b',
        paneTreeVersion: 1,
        paneTree: {
          kind: 'split',
          id: 'split-1',
          dir: 'horizontal',
          ratio: 50,
          a: { kind: 'leaf', id: 'leaf-a', ptyId: 'pty-a' },
          b: { kind: 'leaf', id: 'leaf-b', ptyId: 'pty-b' },
        },
      },
      {
        id: 'tab-2',
        title: 'Two',
        primaryLeafId: 'leaf-c',
        activeLeafId: 'leaf-c',
        paneTreeVersion: 1,
        paneTree: { kind: 'leaf', id: 'leaf-c', ptyId: 'pty-c' },
      },
    ],
  };
}

describe('terminal pane internal split - three-level effects', () => {
  it('closing one leaf emits LEAF_CLOSED and unwraps without closing tab or panel', () => {
    const began = panelReducer(state(), {
      type: 'PANE_ACTION',
      tabId: 'tab-1',
      action: { type: 'CLOSE_LEAF_BEGIN', leafId: 'leaf-b' },
    }).state;

    const result = panelReducer(began, {
      type: 'PANE_ACTION',
      tabId: 'tab-1',
      action: { type: 'CLOSE_LEAF_COMMIT', leafId: 'leaf-b' },
    });

    expect(result.effects).toEqual([
      { type: 'LEAF_CLOSED', tabId: 'tab-1', leafId: 'leaf-b', ptyId: 'pty-b' },
    ]);
    expect(result.state.tabs).toHaveLength(2);
    expect(result.state.activeTabId).toBe('tab-1');
  });

  it('closing the last leaf in one tab emits TAB_CLOSED_AUTO but not PANEL_EMPTY when another tab remains', () => {
    const began = panelReducer(state(), {
      type: 'PANE_ACTION',
      tabId: 'tab-2',
      action: { type: 'CLOSE_LEAF_BEGIN', leafId: 'leaf-c' },
    }).state;

    const result = panelReducer(began, {
      type: 'PANE_ACTION',
      tabId: 'tab-2',
      action: { type: 'CLOSE_LEAF_COMMIT', leafId: 'leaf-c' },
    });

    expect(result.effects).toEqual([
      { type: 'LEAF_CLOSED', tabId: 'tab-2', leafId: 'leaf-c', ptyId: 'pty-c' },
      { type: 'TAB_CLOSED_AUTO', tabId: 'tab-2', ptyIds: ['pty-c'] },
    ]);
    expect(result.effects.some((e) => e.type === 'PANEL_EMPTY')).toBe(false);
    expect(result.state.tabs.map((t) => t.id)).toEqual(['tab-1']);
  });

  it('closing the only tab emits PANEL_EMPTY after TAB_CLOSED_AUTO', () => {
    const onlyTab: PanelState = { ...state(), tabs: [state().tabs[1]!], activeTabId: 'tab-2' };
    const began = panelReducer(onlyTab, {
      type: 'PANE_ACTION',
      tabId: 'tab-2',
      action: { type: 'CLOSE_LEAF_BEGIN', leafId: 'leaf-c' },
    }).state;
    const result = panelReducer(began, {
      type: 'PANE_ACTION',
      tabId: 'tab-2',
      action: { type: 'CLOSE_LEAF_COMMIT', leafId: 'leaf-c' },
    });

    expect(result.effects.map((e) => e.type)).toEqual([
      'LEAF_CLOSED',
      'TAB_CLOSED_AUTO',
      'PANEL_EMPTY',
    ]);
    expect(result.state.activeTabId).toBeNull();
  });
});
