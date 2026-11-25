// @vitest-environment jsdom
// BDD:重启恢复后焦点落在主窗活动编辑器(可直接键入),不抢用户已有的焦点 / 操作。见同目录 README 第 3 条。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import { focusActiveEditorAfterRestore, RESTORE_FOCUS_TIMEOUT_MS } from '@/shell/dock/restore-focus';
import { markDockLayoutRestored, setDockApi } from '@/shell/dock/dock-api-ref';
import { useEditorStore } from '@/stores/editor.store';
import { setContentFocusHandler } from '@/lib/content-focus-target';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** 编辑器面板内容先空着(懒加载未挂上),由 mountEditable 挂可编辑区;其它面板直接带 textarea。 */
function createDock(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: (opts) => {
      const element = document.createElement('div');
      element.dataset.content = opts.id;
      if (opts.id !== 'editor') element.appendChild(document.createElement('textarea'));
      return { element, init: () => {} };
    },
  });
  return dock.api;
}

function mountEditable(): HTMLTextAreaElement {
  const ta = document.createElement('textarea');
  document.querySelector('[data-content="editor"]')!.appendChild(ta);
  return ta;
}

/** rAF → 16ms 定时器(假时钟推进)。 */
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
  useEditorStore.setState({ activeTabId: '/w/a.ts' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setDockApi(null);
  document.body.innerHTML = '';
  useEditorStore.setState({ activeTabId: null });
});

function restoredDock(active: 'editor' | 'terminal' = 'editor'): DockviewApi {
  const api = createDock();
  api.addPanel({ id: 'terminal', component: 'terminal', title: 't' });
  api.addPanel({ id: 'editor', component: 'editor', title: 'e', position: { referencePanel: 'terminal', direction: 'right' } });
  api.getPanel(active)!.api.setActive();
  setDockApi(api, { layoutPending: true });
  markDockLayoutRestored(api);
  (document.activeElement as HTMLElement | null)?.blur();
  return api;
}

describe('启动恢复后聚焦活动编辑器', () => {
  it('焦点在 body、活动面板是编辑器 → 编辑区挂上后获焦', () => {
    restoredDock();
    focusActiveEditorAfterRestore(document);
    vi.advanceTimersByTime(100);
    expect(document.activeElement).toBe(document.body);
    const ta = mountEditable();
    vi.advanceTimersByTime(32);
    expect(document.activeElement).toBe(ta);
  });

  it('落点是编辑器可编辑区 → 走编辑器自己的聚焦(不直接 DOM focus,免得被拉回光标处;见 focus-keeps-scroll)', () => {
    restoredDock();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.querySelector('[data-content="editor"]')!.appendChild(editable);
    const domFocus = vi.spyOn(editable, 'focus');
    const viewFocus = vi.fn(() => HTMLElement.prototype.focus.call(editable));
    setContentFocusHandler(editable, viewFocus);
    focusActiveEditorAfterRestore(document);
    vi.advanceTimersByTime(32);
    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(domFocus).not.toHaveBeenCalled();
  });

  it('布局晚于会话恢复完成 → 等布局就绪后再聚焦', () => {
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'e' });
    setDockApi(api, { layoutPending: true });
    const ta = mountEditable();
    (document.activeElement as HTMLElement | null)?.blur();
    focusActiveEditorAfterRestore(document);
    vi.advanceTimersByTime(100);
    expect(document.activeElement).toBe(document.body);
    markDockLayoutRestored(api);
    vi.advanceTimersByTime(32);
    expect(document.activeElement).toBe(ta);
  });

  it('期间用户按过键 / 点过鼠标 → 不抢', () => {
    restoredDock();
    focusActiveEditorAfterRestore(document);
    document.dispatchEvent(new Event('pointerdown'));
    mountEditable();
    vi.advanceTimersByTime(RESTORE_FOCUS_TIMEOUT_MS + 100);
    expect(document.activeElement).toBe(document.body);
  });

  it('焦点已在别处(非 body)→ 不抢', () => {
    restoredDock();
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    focusActiveEditorAfterRestore(document);
    mountEditable();
    vi.advanceTimersByTime(RESTORE_FOCUS_TIMEOUT_MS + 100);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('活动面板不是编辑器(终端)→ 不聚焦', () => {
    restoredDock('terminal');
    focusActiveEditorAfterRestore(document);
    mountEditable();
    vi.advanceTimersByTime(RESTORE_FOCUS_TIMEOUT_MS + 100);
    expect(document.activeElement).toBe(document.body);
  });

  it('没有打开的 tab → 不聚焦', () => {
    useEditorStore.setState({ activeTabId: null });
    restoredDock();
    mountEditable();
    focusActiveEditorAfterRestore(document);
    vi.advanceTimersByTime(RESTORE_FOCUS_TIMEOUT_MS + 100);
    expect(document.activeElement).toBe(document.body);
  });

  it('限时内编辑区始终没挂上 → 退到面板默认落点(不停在 body)', () => {
    restoredDock();
    const root = document.querySelector<HTMLElement>('[data-content="editor"]')!;
    const fallback = document.createElement('div');
    fallback.setAttribute('data-editor-panel-root', '');
    fallback.tabIndex = -1;
    root.appendChild(fallback);
    focusActiveEditorAfterRestore(document);
    vi.advanceTimersByTime(RESTORE_FOCUS_TIMEOUT_MS + 100);
    expect(document.activeElement).toBe(fallback);
  });
});
