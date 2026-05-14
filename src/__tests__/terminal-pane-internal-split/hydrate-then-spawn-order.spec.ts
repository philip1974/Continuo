import { describe, expect, it } from 'vitest';
import {
  collectLeaves,
  type PaneNodePersisted,
} from '../../panels/Terminal/paneTree';
import {
  panelReducer,
  type PanelState,
} from '../../panels/Terminal/panelReducer';

const tree: PaneNodePersisted = {
  kind: 'split',
  id: 'split-1',
  dir: 'horizontal',
  ratio: 62,
  a: { kind: 'leaf', id: 'leaf-a', cwd: '/a' },
  b: {
    kind: 'split',
    id: 'split-2',
    dir: 'vertical',
    ratio: 40,
    a: { kind: 'leaf', id: 'leaf-b', cwd: '/b' },
    b: { kind: 'leaf', id: 'leaf-c', cwd: '/c' },
  },
};

describe('terminal pane internal split - hydrate then spawn order', () => {
  it('hydrates all leaves before emitting hydrate spawn effects', () => {
    const result = panelReducer(
      { tabs: [], activeTabId: null, hydrated: false },
      {
        type: 'HYDRATE',
        persisted: {
          activeTabId: 'tab-1',
          tabs: [
            {
              id: 'tab-1',
              title: 'Restored',
              primaryLeafId: 'leaf-a',
              paneTreeVersion: 1,
              paneTree: tree,
            },
          ],
        },
      },
    );

    expect(collectLeaves(result.state.tabs[0]!.paneTree).map((l) => l.id)).toEqual([
      'leaf-a',
      'leaf-b',
      'leaf-c',
    ]);
    expect(result.effects.map((e) => e.type)).toEqual([
      'ENQUEUE_SPAWN',
      'ENQUEUE_SPAWN',
      'ENQUEUE_SPAWN',
    ]);
    expect(result.effects.every((e) => e.type === 'ENQUEUE_SPAWN' && e.reason === 'hydrate')).toBe(
      true,
    );
  });

  it('SET_PTY_ID fills an already hydrated leaf without creating a second spawn', () => {
    const hydrated: PanelState = panelReducer(
      { tabs: [], activeTabId: null, hydrated: false },
      {
        type: 'HYDRATE',
        persisted: {
          activeTabId: 'tab-1',
          tabs: [
            {
              id: 'tab-1',
              title: 'Restored',
              primaryLeafId: 'leaf-a',
              paneTreeVersion: 1,
              paneTree: tree,
            },
          ],
        },
      },
    ).state;

    const result = panelReducer(hydrated, {
      type: 'PANE_ACTION',
      tabId: 'tab-1',
      action: { type: 'SET_PTY_ID', leafId: 'leaf-b', ptyId: 'term-b' },
    });

    expect(collectLeaves(result.state.tabs[0]!.paneTree).find((l) => l.id === 'leaf-b')?.ptyId).toBe(
      'term-b',
    );
    expect(result.effects).toEqual([]);
  });
});
