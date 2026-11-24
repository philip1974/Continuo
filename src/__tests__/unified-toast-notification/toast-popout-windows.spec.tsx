// @vitest-environment jsdom
// BDD:面板弹出到 popout 子窗后,toast 同时显示在主窗与每个 popout 子窗;只有一个副本是 live region。见同目录 README T18-T19。
import type { DockviewApi } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { NotificationsProvider } from '@/notifications/NotificationsProvider';
import { ToastViewport } from '@/notifications/ToastViewport';
import { notify } from '@/notifications/notify';
import { trackPopoutDocuments } from '@/shell/dock/popout-documents';
import { makeChildDocument, type ChildDocument } from '../_helpers/child-document';

type Listener = () => void;
function emitter() {
  const ls = new Set<Listener>();
  return {
    on: (l: Listener) => {
      ls.add(l);
      return { dispose: () => ls.delete(l) };
    },
    fire: () => {
      for (const l of [...ls]) l();
    },
  };
}

// 只实现 trackPopoutDocuments 用到的 dockview api 子集。
function fakeDock() {
  const added = emitter();
  const removed = emitter();
  const groups: Array<{ api: { location: unknown; onDidLocationChange: (l: Listener) => { dispose: () => void } } }> = [];
  const api = {
    get groups() {
      return groups;
    },
    onDidAddGroup: added.on,
    onDidRemoveGroup: removed.on,
  };
  return {
    api: api as unknown as DockviewApi,
    addGroup(location: unknown) {
      const move = emitter();
      const g = { api: { location, onDidLocationChange: move.on } };
      groups.push(g);
      added.fire();
      return {
        moveTo(next: unknown) {
          g.api.location = next;
          move.fire();
        },
      };
    },
  };
}

let child: ChildDocument;
let tracker: { dispose: () => void } | null = null;
beforeEach(() => {
  child = makeChildDocument();
});
afterEach(() => {
  cleanup();
  tracker?.dispose();
  tracker = null;
  child.dispose();
  vi.useRealTimers();
});

function renderApp() {
  render(
    <NotificationsProvider>
      <ToastViewport />
    </NotificationsProvider>,
  );
}

const popout = () => ({ type: 'popout', getWindow: () => child.win });
const childToast = () => child.doc.querySelector('.toast');
const mainToasts = () => document.querySelectorAll('.toast');

describe('popout 子窗显示 toast', () => {
  it('T18 popout 组存在时,notify 的 toast 同时渲染在主窗与子窗;组回到主窗后子窗副本移除', () => {
    const dock = fakeDock();
    dock.addGroup({ type: 'grid' });
    const g = dock.addGroup({ type: 'grid' });
    tracker = trackPopoutDocuments(dock.api);
    renderApp();
    act(() => g.moveTo(popout()));

    act(() => notify.error('save failed', { code: 'E_SAVE' }));
    expect(mainToasts()).toHaveLength(1);
    expect(childToast()?.textContent).toContain('save failed');
    expect(child.doc.querySelector('.toast-viewport')?.getAttribute('role')).toBe('region');

    act(() => g.moveTo({ type: 'grid' }));
    expect(childToast()).toBeNull();
    expect(mainToasts()).toHaveLength(1);
  });

  it('T18c 多个 popout 时前一个收回,后一个子窗里的 toast 不被卸载重挂(同一 DOM 实例)', () => {
    const second = makeChildDocument();
    try {
      const dock = fakeDock();
      const first = dock.addGroup(popout());
      dock.addGroup({ type: 'popout', getWindow: () => second.win });
      tracker = trackPopoutDocuments(dock.api);
      renderApp();
      act(() => notify.info('hello'));
      const before = second.doc.querySelector('.toast');
      expect(before).not.toBeNull();

      act(() => first.moveTo({ type: 'grid' }));
      expect(childToast()).toBeNull();
      expect(second.doc.querySelector('.toast')).toBe(before);
    } finally {
      cleanup(); // 先卸载 portal 再移除第二个子窗(afterEach 的 cleanup 晚于此处)
      second.dispose();
    }
  });

  it('T18b 关闭按钮在子窗也有效;在子窗悬停同样暂停计时', () => {
    vi.useFakeTimers();
    const dock = fakeDock();
    dock.addGroup(popout());
    tracker = trackPopoutDocuments(dock.api);
    renderApp();
    act(() => notify.info('hello'));
    fireEvent.mouseEnter(childToast()!);
    act(() => vi.advanceTimersByTime(20000));
    expect(childToast()).not.toBeNull();
    fireEvent.click(childToast()!.querySelector('.toast__dismiss')!);
    expect(childToast()).toBeNull();
    expect(mainToasts()).toHaveLength(0);
  });

  it('T19 只有一个副本是 live region(默认主窗;子窗有焦点时归子窗),读屏不重复播报', () => {
    const dock = fakeDock();
    dock.addGroup(popout());
    tracker = trackPopoutDocuments(dock.api);
    renderApp();

    act(() => notify.error('first'));
    const liveIn = (doc: Document) => doc.querySelectorAll('[aria-live]').length;
    expect(liveIn(document)).toBe(1);
    expect(liveIn(child.doc)).toBe(0);
    expect(child.doc.querySelector('[role="alert"]')).toBeNull();

    vi.spyOn(child.doc, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => notify.error('second'));
    // 已有的 first 不改变播报位置;second 只在子窗播报。
    expect(liveIn(document)).toBe(1);
    expect(liveIn(child.doc)).toBe(1);
    expect(child.doc.querySelector('[role="alert"]')?.textContent).toContain('second');
  });
});
