/**
 * P0-3: renderer 端 tryAttachExisting 失败(limit/duplicate)时,InternalTerminalPanel
 * 通过 coApi.terminal.attachRejected(sid, reason) 反向通知 main → main remove session。
 *
 * 本 spec 锁 reducer + PanelEffect 的 contract:ATTACH_EXISTING_PTY_AS_TAB 拒
 * 时 emit TAB_ATTACH_REJECTED + 含 ptyId + reason。集成层(InternalTerminalPanel
 * subscriber 调 attachRejected)由 panel-reducer-attach-detach + manual integration
 * 路径保证;本 spec 是 reducer-level contract。
 */
import { describe, expect, it } from 'vitest';
import {
  panelReducer,
  PANEL_TAB_LIMIT,
  type PanelState,
} from '../../panels/Terminal/panelReducer';

function makeFull(): PanelState {
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

describe('terminal-tab-drag-split: attach-rejected reverse notify contract', () => {
  it('limit rejection emits TAB_ATTACH_REJECTED with reason=limit + ptyId', () => {
    const result = panelReducer(makeFull(), {
      type: 'ATTACH_EXISTING_PTY_AS_TAB',
      tabId: 'tab-new',
      primaryLeafId: 'leaf-new',
      title: 'agent',
      ptyId: 'pty-new',
      originHint: 'agent',
    });
    expect(result.effects).toContainEqual({
      type: 'TAB_ATTACH_REJECTED',
      ptyId: 'pty-new',
      reason: 'limit',
    });
  });

  it('duplicate rejection emits reason=duplicate', () => {
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
          paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-dup' },
        },
      ],
    };
    const result = panelReducer(state, {
      type: 'ATTACH_EXISTING_PTY_AS_TAB',
      tabId: 'tab-2',
      primaryLeafId: 'leaf-2',
      title: 'dup',
      ptyId: 'pty-dup',
    });
    expect(result.effects).toContainEqual({
      type: 'TAB_ATTACH_REJECTED',
      ptyId: 'pty-dup',
      reason: 'duplicate',
    });
  });
});
