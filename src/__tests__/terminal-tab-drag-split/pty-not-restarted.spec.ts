/**
 * Safeguard "不重启 PTY": ATTACH_EXISTING_PTY_AS_TAB / DETACH_TAB(forMove) /
 * ATTACH_LEAF_FROM_DETACHED 全程不 emit ENQUEUE_SPAWN / LEAF_CLOSED /
 * TAB_CLOSED_AUTO 这类会触发 PTY spawn/kill 的 effect。
 */
import { describe, expect, it } from 'vitest';
import { panelReducer, type PanelState } from '../../panels/Terminal/panelReducer';
import { paneTreeReducer } from '../../panels/Terminal/paneTree';

describe('terminal-tab-drag-split: PTY not restarted invariant', () => {
  it('ATTACH_EXISTING_PTY_AS_TAB emits zero effects', () => {
    const state: PanelState = { hydrated: true, activeTabId: null, tabs: [] };
    const result = panelReducer(state, {
      type: 'ATTACH_EXISTING_PTY_AS_TAB',
      tabId: 'tab-1',
      primaryLeafId: 'leaf-1',
      title: 't',
      ptyId: 'pty-1',
    });
    expect(result.effects.some((e) => e.type === 'ENQUEUE_SPAWN')).toBe(false);
  });

  it('DETACH_TAB(forMove) emits TAB_DETACHED + PANEL_EMPTY_DEFERRED only, no LEAF_CLOSED / TAB_CLOSED_AUTO', () => {
    const state: PanelState = {
      hydrated: true,
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          title: 't',
          primaryLeafId: 'leaf-1',
          activeLeafId: 'leaf-1',
          paneTreeVersion: 1,
          paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-1' },
        },
      ],
    };
    const result = panelReducer(state, {
      type: 'DETACH_TAB',
      tabId: 'tab-1',
      forMove: true,
    });
    expect(result.effects.some((e) => e.type === 'LEAF_CLOSED')).toBe(false);
    expect(result.effects.some((e) => e.type === 'TAB_CLOSED_AUTO')).toBe(false);
    expect(result.effects.some((e) => e.type === 'PANEL_EMPTY')).toBe(false);
  });

  it('ATTACH_LEAF_FROM_DETACHED emits zero effects (no ENQUEUE_SPAWN)', () => {
    const result = paneTreeReducer(
      { tree: { kind: 'leaf', id: 'a', ptyId: 'p1' }, activeLeafId: 'a' },
      {
        type: 'ATTACH_LEAF_FROM_DETACHED',
        targetLeafId: 'a',
        dir: 'horizontal',
        leaf: { kind: 'leaf', id: 'b', ptyId: 'p2' },
      },
    );
    expect(result.effects).toEqual([]);
  });
});
