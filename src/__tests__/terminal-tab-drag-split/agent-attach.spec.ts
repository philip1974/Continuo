/**
 * R1: agent 用 MCP 建出的 session 在 200ms 内通过 panelReducer
 * ATTACH_EXISTING_PTY_AS_TAB 落到 InternalTerminalPanel 内嵌 tab list,
 * 绑现有 ptyId,**不 emit ENQUEUE_SPAWN**(关键 invariant)。
 */
import { describe, expect, it } from 'vitest';
import { panelReducer, type PanelState } from '../../panels/Terminal/panelReducer';

function emptyHydratedState(): PanelState {
  return { hydrated: true, activeTabId: null, tabs: [] };
}

describe('terminal-tab-drag-split: agent attach', () => {
  it('ATTACH_EXISTING_PTY_AS_TAB adds tab with ptyId bound, NO ENQUEUE_SPAWN', () => {
    const result = panelReducer(emptyHydratedState(), {
      type: 'ATTACH_EXISTING_PTY_AS_TAB',
      tabId: 'tab-agent-1',
      primaryLeafId: 'leaf-agent-1',
      title: 'agent-test',
      ptyId: 'pty-from-mcp',
      cwd: '/home',
      originHint: 'agent',
      agentLabel: 'codex',
    });
    expect(result.state.tabs).toHaveLength(1);
    const tab = result.state.tabs[0];
    expect(tab?.id).toBe('tab-agent-1');
    expect(tab?.title).toBe('agent-test');
    expect(tab?.originHint).toBe('agent');
    expect(tab?.agentLabel).toBe('codex');
    expect(tab?.paneTree.kind).toBe('leaf');
    if (tab?.paneTree.kind === 'leaf') {
      expect(tab.paneTree.ptyId).toBe('pty-from-mcp');
      expect(tab.paneTree.spawnPending).toBe(false);
    }
    expect(result.state.activeTabId).toBe('tab-agent-1');
    // 关键:无 ENQUEUE_SPAWN(plan-v2 R1 / Safeguard "不重启 PTY")
    expect(result.effects.some((e) => e.type === 'ENQUEUE_SPAWN')).toBe(false);
    expect(result.effects).toEqual([]);
  });

  it('rejects duplicate ptyId attach', () => {
    const state: PanelState = {
      hydrated: true,
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          title: 'existing',
          primaryLeafId: 'leaf-1',
          activeLeafId: 'leaf-1',
          paneTreeVersion: 1,
          paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-dup' },
        },
      ],
    };
    const result = panelReducer(state, {
      type: 'ATTACH_EXISTING_PTY_AS_TAB',
      tabId: 'tab-new',
      primaryLeafId: 'leaf-new',
      title: 'duplicate',
      ptyId: 'pty-dup',
    });
    expect(result.state).toBe(state);
    expect(result.effects).toContainEqual({
      type: 'TAB_ATTACH_REJECTED',
      ptyId: 'pty-dup',
      reason: 'duplicate',
    });
  });
});
