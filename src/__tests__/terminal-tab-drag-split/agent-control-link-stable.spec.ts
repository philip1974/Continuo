/**
 * Safeguard #1 "agent 控制链不能塌": 跨 detach + reattach 全程 PTY 不重启,
 * session_id 不变,main 端 sessions service 仍然能找到该 session。
 *
 * 本 spec 锁 reducer-level invariant:DETACH_TAB 不会 emit 任何会触发
 * sessionsService.remove() 或 termService.kill() 的 effect。
 * 实际 main 端 sessionsService.remove() 是由 PanelEffect.LEAF_CLOSED /
 * TAB_CLOSED_AUTO 触发的(见 TerminalPanel handlePanelEffect),DETACH_TAB
 * 不应 emit 这两类 effect。
 */
import { describe, expect, it } from 'vitest';
import { panelReducer, type PanelState } from '../../panels/Terminal/panelReducer';

function singleTabState(): PanelState {
  return {
    hydrated: true,
    activeTabId: 'tab-agent',
    tabs: [
      {
        id: 'tab-agent',
        title: 'agent-codex',
        primaryLeafId: 'leaf-1',
        activeLeafId: 'leaf-1',
        paneTreeVersion: 1,
        paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-codex' },
        originHint: 'agent',
        agentLabel: 'codex',
      },
    ],
  };
}

describe('terminal-tab-drag-split: agent control link stable across detach', () => {
  it('DETACH_TAB(forMove) does NOT emit LEAF_CLOSED (which would kill PTY)', () => {
    const result = panelReducer(singleTabState(), {
      type: 'DETACH_TAB',
      tabId: 'tab-agent',
      forMove: true,
    });
    expect(result.effects.some((e) => e.type === 'LEAF_CLOSED')).toBe(false);
  });

  it('DETACH_TAB(forMove) does NOT emit TAB_CLOSED_AUTO (which would kill PTY)', () => {
    const result = panelReducer(singleTabState(), {
      type: 'DETACH_TAB',
      tabId: 'tab-agent',
      forMove: true,
    });
    expect(result.effects.some((e) => e.type === 'TAB_CLOSED_AUTO')).toBe(false);
  });

  it('leafSnapshot preserves ptyId so caller can reattach with same session', () => {
    const result = panelReducer(singleTabState(), {
      type: 'DETACH_TAB',
      tabId: 'tab-agent',
      forMove: true,
    });
    const detached = result.effects.find((e) => e.type === 'TAB_DETACHED');
    expect(detached).toBeDefined();
    if (detached?.type === 'TAB_DETACHED') {
      expect(detached.leafSnapshot.ptyId).toBe('pty-codex');
    }
  });
});
