/**
 * V1 simplified preflight (P0-1 trade-off in plan-v2 changelog):
 * tab limit 不在 main 端 preflight,而是在 renderer reducer 拒绝;
 * renderer 通过 coApi.terminal.attachRejected(sid, 'limit') 反向通知 main 删 session。
 * 本 spec 锁住 reducer 端的 invariant — 实际反向通知由 InternalTerminalPanel
 * 的 onSessionsChanged subscriber 触发(集成层面)。
 *
 * 注意:plan-v2 changelog 明确这是 V1 妥协 — agent 可能短瞬态拿到 sid 后报
 * NOT_FOUND。V2 应做 main 端 reserveAttachSlot。
 */
import { describe, expect, it } from 'vitest';
import {
  PANEL_TAB_LIMIT,
  panelReducer,
  type PanelState,
} from '../../panels/Terminal/panelReducer';

function fullState(): PanelState {
  return {
    hydrated: true,
    activeTabId: 'tab-0',
    tabs: Array.from({ length: PANEL_TAB_LIMIT }, (_, i) => ({
      id: `tab-${i}`,
      title: `T${i}`,
      primaryLeafId: `leaf-${i}`,
      activeLeafId: `leaf-${i}`,
      paneTreeVersion: 1 as const,
      paneTree: { kind: 'leaf' as const, id: `leaf-${i}`, ptyId: `pty-${i}` },
    })),
  };
}

describe('terminal-tab-drag-split: V1 preflight (reducer-side reject)', () => {
  it('emits TAB_ATTACH_REJECTED reason=limit at full', () => {
    const state = fullState();
    const result = panelReducer(state, {
      type: 'ATTACH_EXISTING_PTY_AS_TAB',
      tabId: 'tab-overflow',
      primaryLeafId: 'leaf-overflow',
      title: 'overflow',
      ptyId: 'pty-X',
    });
    const rejected = result.effects.find((e) => e.type === 'TAB_ATTACH_REJECTED');
    expect(rejected).toBeDefined();
    if (rejected?.type === 'TAB_ATTACH_REJECTED') {
      expect(rejected.reason).toBe('limit');
      expect(rejected.ptyId).toBe('pty-X');
    }
    // 关键:state 不变(reducer 是 pure)
    expect(result.state).toBe(state);
  });

  it('does not emit ENQUEUE_SPAWN when rejected', () => {
    const result = panelReducer(fullState(), {
      type: 'ATTACH_EXISTING_PTY_AS_TAB',
      tabId: 'x',
      primaryLeafId: 'lx',
      title: 'x',
      ptyId: 'px',
    });
    expect(result.effects.some((e) => e.type === 'ENQUEUE_SPAWN')).toBe(false);
  });
});
