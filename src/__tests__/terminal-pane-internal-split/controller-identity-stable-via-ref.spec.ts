import { describe, expect, it, vi } from 'vitest';
import {
  createPaneController,
  registerPaneController,
} from '../../panels/Terminal/PaneControllerRegistry';
import type { PanelState } from '../../panels/Terminal/panelReducer';

describe('terminal pane internal split - controller identity stable via ref', () => {
  it('registers and returns the same controller object while state ref changes', () => {
    const dispatch = vi.fn();
    const stateRef = {
      current: {
        hydrated: true,
        activeTabId: 'tab-1',
        tabs: [
          {
            id: 'tab-1',
            title: 'One',
            primaryLeafId: 'leaf-1',
            activeLeafId: 'leaf-1',
            paneTreeVersion: 1,
            paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-1' },
          },
        ],
      } satisfies PanelState,
    };
    const controller = createPaneController({
      panelId: 'panel-1',
      windowId: 7,
      dispatch,
      dispatchAndCollect: vi.fn().mockReturnValue([]),
      stateRef,
      removedPtyIds: new Set(),
      closePanel: vi.fn(),
    });
    const unregister = registerPaneController(7, 'panel-1', controller);
    const first = controller;

    stateRef.current = {
      ...stateRef.current,
      activeTabId: 'tab-2',
      tabs: [
        ...stateRef.current.tabs,
        {
          id: 'tab-2',
          title: 'Two',
          primaryLeafId: 'leaf-2',
          activeLeafId: 'leaf-2',
          paneTreeVersion: 1,
          paneTree: { kind: 'leaf', id: 'leaf-2', ptyId: 'pty-2' },
        },
      ],
    };

    expect(first).toBe(controller);
    expect(controller.getCurrentTabId()).toBe('tab-2');
    expect(controller.getCurrentPtyIds()).toEqual(['pty-1', 'pty-2']);
    unregister();
  });

  it('filters already removed pty ids from panel close lookup', () => {
    const removedPtyIds = new Set(['pty-1']);
    const controller = createPaneController({
      panelId: 'panel-1',
      windowId: 7,
      dispatch: vi.fn(),
      dispatchAndCollect: vi.fn().mockReturnValue([]),
      removedPtyIds,
      closePanel: vi.fn(),
      stateRef: {
        current: {
          hydrated: true,
          activeTabId: 'tab-1',
          tabs: [
            {
              id: 'tab-1',
              title: 'One',
              primaryLeafId: 'leaf-1',
              activeLeafId: 'leaf-1',
              paneTreeVersion: 1,
              paneTree: {
                kind: 'split',
                id: 'split-1',
                dir: 'horizontal',
                ratio: 50,
                a: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-1' },
                b: { kind: 'leaf', id: 'leaf-2', ptyId: 'pty-2' },
              },
            },
          ],
        },
      },
    });

    expect(controller.getCurrentPtyIds()).toEqual(['pty-2']);
  });
});
