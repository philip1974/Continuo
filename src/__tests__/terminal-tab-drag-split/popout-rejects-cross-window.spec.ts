/**
 * NEED-INFO-1: popout 子窗口 + 跨窗口 drag 处理:
 * - isPopoutWindow() === true → DockShell drop handler 不装(popout 短路 DockShell)
 * - payload.windowId !== current windowId → drop handler 直接 return
 *
 * 这层是 DockShell + tab-drag-payload 的协同 invariant。本 spec 锁
 * decodeTabDragPayload 在 cross-window payload 上的可观测行为(decoded 含
 * windowId,caller 据此判断)。
 */
import { describe, expect, it } from 'vitest';
import {
  TAB_DRAG_MIME,
  decodeTabDragPayload,
  encodeTabDragPayload,
  type TabDragPayload,
} from '../../lib/tab-drag-payload';
import { isPopoutWindow } from '../../lib/popout-mode';

// jsdom 不实现 DataTransfer 类,用 stub 模拟最小接口(getData / setData / types)。
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

describe('terminal-tab-drag-split: popout / cross-window guard', () => {
  it('isPopoutWindow returns false in test env (jsdom)', () => {
    // jsdom default URL 不带 ?popout=1
    expect(isPopoutWindow()).toBe(false);
  });

  it('decoded payload carries windowId; caller can compare to current', () => {
    const payload: TabDragPayload = {
      version: 1,
      windowId: 99,
      sourcePanelId: 'p',
      sourceTabId: 't',
      sourceLeafId: 'l',
      ptyId: 'pty',
      sessionId: 'pty',
      title: 'x',
    };
    const dt = makeDataTransferStub();
    dt.setData(TAB_DRAG_MIME, encodeTabDragPayload(payload));
    const decoded = decodeTabDragPayload(dt as unknown as DataTransfer);
    expect(decoded?.windowId).toBe(99);
  });
});
