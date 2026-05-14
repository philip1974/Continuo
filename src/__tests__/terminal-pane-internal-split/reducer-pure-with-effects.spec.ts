import { describe, expect, it } from 'vitest';
import {
  panelReducer,
  type PanelState,
} from '../../panels/Terminal/panelReducer';

const emptyState: PanelState = { tabs: [], activeTabId: null, hydrated: false };

describe('terminal pane internal split - pure reducer with effects', () => {
  it('HYDRATE returns next PanelState plus effects without storing effects on state', () => {
    const result = panelReducer(emptyState, {
      type: 'HYDRATE',
      persisted: {
        activeTabId: 'tab-1',
        tabs: [
          {
            id: 'tab-1',
            title: 'Terminal',
            primaryLeafId: 'leaf-1',
            paneTreeVersion: 1,
            paneTree: { kind: 'leaf', id: 'leaf-1', cwd: '/repo' },
          },
        ],
      },
    });

    expect(result.state).toMatchObject({
      hydrated: true,
      activeTabId: 'tab-1',
    });
    expect('_effect' in result.state).toBe(false);
    expect(result.effects).toEqual([
      {
        type: 'ENQUEUE_SPAWN',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        cwd: '/repo',
        scoped: true,
        reason: 'hydrate',
      },
    ]);
  });

  it('ADD_TAB emits addTab spawn effect and keeps React state effect-free', () => {
    const result = panelReducer({ ...emptyState, hydrated: true }, {
      type: 'ADD_TAB',
      tabId: 'tab-2',
      primaryLeafId: 'leaf-2',
      title: 'Terminal',
      cwd: '/tmp',
    });

    expect(result.state.tabs).toHaveLength(1);
    expect(result.state.activeTabId).toBe('tab-2');
    expect('_effect' in result.state).toBe(false);
    expect(result.effects[0]).toMatchObject({
      type: 'ENQUEUE_SPAWN',
      tabId: 'tab-2',
      leafId: 'leaf-2',
      reason: 'addTab',
    });
  });

  it('SELECT_TAB is pure and emits no effects', () => {
    const state: PanelState = {
      hydrated: true,
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          title: 'One',
          primaryLeafId: 'leaf-1',
          activeLeafId: 'leaf-1',
          paneTreeVersion: 1,
          paneTree: { kind: 'leaf', id: 'leaf-1' },
        },
        {
          id: 'tab-2',
          title: 'Two',
          primaryLeafId: 'leaf-2',
          activeLeafId: 'leaf-2',
          paneTreeVersion: 1,
          paneTree: { kind: 'leaf', id: 'leaf-2' },
        },
      ],
    };

    const result = panelReducer(state, { type: 'SELECT_TAB', tabId: 'tab-2' });

    expect(result.state.activeTabId).toBe('tab-2');
    expect(result.effects).toEqual([]);
  });
});
