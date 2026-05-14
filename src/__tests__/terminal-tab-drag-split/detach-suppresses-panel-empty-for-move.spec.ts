/**
 * P0-4: DETACH_TAB({ forMove: true }) 在 state.tabs 清零时 emit
 * PANEL_EMPTY_DEFERRED 而非 PANEL_EMPTY,原 panel 不立即 close。
 * forMove: false / undefined 时保持旧行为(PANEL_EMPTY → panelApi.close)。
 */
import { describe, expect, it } from 'vitest';
import { panelReducer, type PanelState } from '../../panels/Terminal/panelReducer';

function singleTabState(): PanelState {
  return {
    hydrated: true,
    activeTabId: 'tab-1',
    tabs: [
      {
        id: 'tab-1',
        title: 'One',
        primaryLeafId: 'leaf-1',
        activeLeafId: 'leaf-1',
        paneTreeVersion: 1,
        paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-1', cwd: '/a' },
      },
    ],
  };
}

describe('terminal-tab-drag-split: DETACH_TAB forMove suppresses PANEL_EMPTY', () => {
  it('emits PANEL_EMPTY_DEFERRED when forMove=true and tabs become empty', () => {
    const result = panelReducer(singleTabState(), {
      type: 'DETACH_TAB',
      tabId: 'tab-1',
      forMove: true,
    });
    expect(result.state.tabs).toEqual([]);
    expect(result.effects.some((e) => e.type === 'TAB_DETACHED')).toBe(true);
    expect(result.effects.some((e) => e.type === 'PANEL_EMPTY_DEFERRED')).toBe(true);
    expect(result.effects.some((e) => e.type === 'PANEL_EMPTY')).toBe(false);
  });

  it('emits PANEL_EMPTY (eager close) when forMove=false', () => {
    const result = panelReducer(singleTabState(), {
      type: 'DETACH_TAB',
      tabId: 'tab-1',
      forMove: false,
    });
    expect(result.state.tabs).toEqual([]);
    expect(result.effects.some((e) => e.type === 'PANEL_EMPTY')).toBe(true);
    expect(result.effects.some((e) => e.type === 'PANEL_EMPTY_DEFERRED')).toBe(false);
  });

  it('rejects DETACH_TAB on split-tab paneTree (V1 limit)', () => {
    const state: PanelState = {
      hydrated: true,
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          title: 'One',
          primaryLeafId: 'leaf-a',
          activeLeafId: 'leaf-a',
          paneTreeVersion: 1,
          paneTree: {
            kind: 'split',
            id: 's1',
            dir: 'horizontal',
            ratio: 50,
            a: { kind: 'leaf', id: 'leaf-a', ptyId: 'pty-a' },
            b: { kind: 'leaf', id: 'leaf-b', ptyId: 'pty-b' },
          },
        },
      ],
    };
    const result = panelReducer(state, {
      type: 'DETACH_TAB',
      tabId: 'tab-1',
      forMove: true,
    });
    expect(result.state).toBe(state); // 未变更
    expect(result.effects).toContainEqual({
      type: 'TAB_DETACH_REJECTED',
      tabId: 'tab-1',
      reason: 'split-tab',
    });
  });

  it('rejects DETACH_TAB on tab not found', () => {
    const result = panelReducer(singleTabState(), {
      type: 'DETACH_TAB',
      tabId: 'tab-missing',
      forMove: true,
    });
    expect(result.effects).toContainEqual({
      type: 'TAB_DETACH_REJECTED',
      tabId: 'tab-missing',
      reason: 'not-found',
    });
  });
});
