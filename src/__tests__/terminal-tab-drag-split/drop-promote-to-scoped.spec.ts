/**
 * R2-1: DETACH_TAB + payload encode/decode + dockview addPanel 时序的 contract:
 * - tab-drag-payload encode/decode round-trip
 * - DETACH_TAB(forMove:true) 同步 effects 含 TAB_DETACHED(leafSnapshot)
 * - leafSnapshot.ptyId 等于原 leaf.ptyId(不 spawn 新 PTY)
 *
 * dockview addPanel 调用本身的集成测试放 real-test;这里只锁 contract。
 */
import { describe, expect, it } from 'vitest';
import { panelReducer, type PanelState } from '../../panels/Terminal/panelReducer';
import {
  TAB_DRAG_MIME,
  decodeTabDragPayload,
  encodeTabDragPayload,
  type TabDragPayload,
} from '../../lib/tab-drag-payload';

// jsdom 不实现 DataTransfer 类,用 stub 模拟最小接口。
function makeDataTransferStub() {
  const store = new Map<string, string>();
  return {
    setData(type: string, value: string) {
      store.set(type, value);
    },
    getData(type: string): string {
      return store.get(type) ?? '';
    },
    get types(): readonly string[] {
      return Array.from(store.keys());
    },
  };
}

describe('terminal-tab-drag-split: drop promote to scoped contract', () => {
  it('DETACH_TAB forMove returns leafSnapshot with original ptyId', () => {
    const state: PanelState = {
      hydrated: true,
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          title: 'Terminal',
          primaryLeafId: 'leaf-1',
          activeLeafId: 'leaf-1',
          paneTreeVersion: 1,
          paneTree: { kind: 'leaf', id: 'leaf-1', ptyId: 'pty-orig', cwd: '/repo' },
        },
        {
          id: 'tab-2',
          title: 'Terminal 2',
          primaryLeafId: 'leaf-2',
          activeLeafId: 'leaf-2',
          paneTreeVersion: 1,
          paneTree: { kind: 'leaf', id: 'leaf-2', ptyId: 'pty-2' },
        },
      ],
    };
    const result = panelReducer(state, {
      type: 'DETACH_TAB',
      tabId: 'tab-1',
      forMove: true,
    });
    expect(result.state.tabs).toHaveLength(1);
    expect(result.state.tabs[0]?.id).toBe('tab-2');
    expect(result.state.activeTabId).toBe('tab-2');
    const detached = result.effects.find((e) => e.type === 'TAB_DETACHED');
    expect(detached).toBeDefined();
    if (detached?.type === 'TAB_DETACHED') {
      expect(detached.tabId).toBe('tab-1');
      expect(detached.leafSnapshot.ptyId).toBe('pty-orig');
      expect(detached.leafSnapshot.cwd).toBe('/repo');
    }
  });

  it('tab-drag-payload encode/decode round-trip', () => {
    const dt = makeDataTransferStub();
    const payload: TabDragPayload = {
      version: 1,
      windowId: 42,
      sourcePanelId: 'panel-A',
      sourceTabId: 'tab-3',
      sourceLeafId: 'leaf-3',
      ptyId: 'pty-3',
      sessionId: 'pty-3',
      title: 'Terminal 3',
    };
    dt.setData(TAB_DRAG_MIME, encodeTabDragPayload(payload));
    const decoded = decodeTabDragPayload(dt as unknown as DataTransfer);
    expect(decoded).toEqual(payload);
  });

  it('decodeTabDragPayload returns null for missing / malformed', () => {
    expect(decodeTabDragPayload(null)).toBeNull();
    const dt = makeDataTransferStub();
    dt.setData('text/plain', 'not-our-mime');
    expect(decodeTabDragPayload(dt as unknown as DataTransfer)).toBeNull();
    dt.setData(TAB_DRAG_MIME, 'not-json');
    expect(decodeTabDragPayload(dt as unknown as DataTransfer)).toBeNull();
    dt.setData(TAB_DRAG_MIME, JSON.stringify({ version: 99 }));
    expect(decodeTabDragPayload(dt as unknown as DataTransfer)).toBeNull();
  });
});
