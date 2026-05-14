/**
 * P0-1 (V1 simplified): tab 上限 20 在 reducer 兜底拒绝 ATTACH_EXISTING_PTY_AS_TAB。
 * V1 不在 main 端做 preflight reservation;renderer 拒绝后通过 attachRejected
 * IPC 反向通知 main 清理(见 plan-v2 changelog P0-1 trade-off)。
 */
import { describe, expect, it } from 'vitest';
import { PANEL_TAB_LIMIT, panelReducer, type PanelState } from '../../panels/Terminal/panelReducer';

function manyTabsState(n: number): PanelState {
  return {
    hydrated: true,
    activeTabId: 'tab-0',
    tabs: Array.from({ length: n }, (_, i) => ({
      id: `tab-${i}`,
      title: `T${i}`,
      primaryLeafId: `leaf-${i}`,
      activeLeafId: `leaf-${i}`,
      paneTreeVersion: 1 as const,
      paneTree: { kind: 'leaf' as const, id: `leaf-${i}`, ptyId: `pty-${i}` },
    })),
  };
}

describe('terminal-tab-drag-split: tab limit', () => {
  it('PANEL_TAB_LIMIT constant is 20', () => {
    expect(PANEL_TAB_LIMIT).toBe(20);
  });

  it('rejects ATTACH_EXISTING_PTY_AS_TAB at limit', () => {
    const state = manyTabsState(PANEL_TAB_LIMIT);
    const result = panelReducer(state, {
      type: 'ATTACH_EXISTING_PTY_AS_TAB',
      tabId: 'tab-overflow',
      primaryLeafId: 'leaf-overflow',
      title: 'overflow',
      ptyId: 'pty-overflow',
    });
    expect(result.state).toBe(state);
    expect(result.effects).toContainEqual({
      type: 'TAB_ATTACH_REJECTED',
      ptyId: 'pty-overflow',
      reason: 'limit',
    });
  });

  it('accepts attach below limit', () => {
    const state = manyTabsState(PANEL_TAB_LIMIT - 1);
    const result = panelReducer(state, {
      type: 'ATTACH_EXISTING_PTY_AS_TAB',
      tabId: 'tab-last',
      primaryLeafId: 'leaf-last',
      title: 'last',
      ptyId: 'pty-last',
    });
    expect(result.state.tabs).toHaveLength(PANEL_TAB_LIMIT);
    expect(result.effects).toEqual([]);
  });
});
