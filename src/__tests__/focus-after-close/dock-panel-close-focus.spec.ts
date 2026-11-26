// @vitest-environment jsdom
// BDD:关闭同组里非最后一个面板后,焦点交给同组新的活动面板;关掉整组后 MRU 回落的面板(不限终端)获焦;
// 焦点原本不在被关面板所在组里时不抢焦点。见同目录 README 第 2 条。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import { wrapPanelClose } from '@/shell/dock/wrap-panel-close';
import { trackGroupMru } from '@/shell/dock/group-mru';
import { EXIT_DURATION_MS } from '@/shell/motion/tokens';
import { useClosingStore } from '@/stores/closing.store';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** 真实 dockview;每个面板内容里放一个可编辑的 textarea(编辑器 / 终端输入区的替身)。 */
function createDock(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: (opts) => {
      const element = document.createElement('div');
      const editable = document.createElement('textarea');
      editable.dataset.panel = opts.id;
      element.appendChild(editable);
      // 面板里的其它控件(如终端搜索条 / 编辑器查找框的按钮)
      const control = document.createElement('button');
      control.dataset.control = opts.id;
      element.appendChild(control);
      return { element, init: () => {} };
    },
  });
  dock.api.onDidAddPanel((p) => wrapPanelClose(p));
  // 同 DockShell:面板真被移除后摘掉 closing 标记(否则下一个用例里同 id 面板的 close 被当成重复关闭)
  dock.api.onDidRemovePanel((p) => useClosingStore.getState().unmark(p.id));
  return dock.api;
}

const editableOf = (id: string) => document.querySelector<HTMLTextAreaElement>(`textarea[data-panel="${id}"]`)!;
const waitClose = () => new Promise((r) => setTimeout(r, EXIT_DURATION_MS + 20));
const flushMicrotasks = () => new Promise<void>((r) => queueMicrotask(r));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** 同组三个 tab:editor | t1 | t2,t2 活动。 */
function oneGroup(api: DockviewApi) {
  api.addPanel({ id: 'editor', component: 'editor', title: 'editor' });
  api.addPanel({ id: 't1', component: 'terminal', title: 't1', position: { referencePanel: 'editor', direction: 'within' } });
  api.addPanel({ id: 't2', component: 'terminal', title: 't2', position: { referencePanel: 'editor', direction: 'within' } });
}

describe('关闭同组里非最后一个面板', () => {
  it('焦点在被关面板里 → 关闭后同组新的活动面板获焦', async () => {
    const api = createDock();
    oneGroup(api);
    editableOf('t2').focus();
    expect(document.activeElement).toBe(editableOf('t2'));

    api.getPanel('t2')!.api.close();
    await waitClose();
    await flushMicrotasks();

    const next = api.activePanel!;
    expect(next.id).not.toBe('t2');
    expect(document.activeElement).toBe(editableOf(next.id));
  });

  it('焦点已丢到 body(如被关面板的内容先卸载)→ 同样交给新的活动面板', async () => {
    const api = createDock();
    oneGroup(api);
    (document.activeElement as HTMLElement | null)?.blur();

    api.getPanel('t2')!.api.close();
    await waitClose();
    await flushMicrotasks();

    expect(document.activeElement).toBe(editableOf(api.activePanel!.id));
  });

  it('关闭的是同组非活动面板 → 不动焦点(活动面板里聚焦在其它控件上也不被拉回编辑区)', async () => {
    const api = createDock();
    oneGroup(api);
    const control = document.querySelector<HTMLButtonElement>('button[data-control="t2"]')!;
    control.focus();

    api.getPanel('t1')!.api.close();
    await waitClose();
    await flushMicrotasks();

    expect(api.getPanel('t1')).toBeUndefined();
    expect(api.activePanel?.id).toBe('t2');
    expect(document.activeElement).toBe(control);
  });

  // tab 右键菜单「关闭」先把焦点还给被右键的 tab,随后它随面板一起移除 → 焦点会落到 body、键入丢失。
  // VSCode(同点 ×):焦点留在该组活动的编辑器 / 面板里。
  it('关闭非活动面板、焦点在它的 tab 上(随面板移除而丢失)→ 同组活动面板获焦', async () => {
    const api = createDock();
    oneGroup(api);
    const t1Tab = api.getPanel('t1')!.view.tab.element;
    t1Tab.tabIndex = 0; // 同 SharedTab:tab 根可聚焦
    t1Tab.focus();
    expect(document.activeElement).toBe(t1Tab);

    api.getPanel('t1')!.api.close();
    await waitClose();
    await flushMicrotasks();

    expect(api.getPanel('t1')).toBeUndefined();
    expect(api.activePanel?.id).toBe('t2');
    expect(document.activeElement).toBe(editableOf('t2'));
  });

  it('焦点在组外(如 Explorer)→ 不抢焦点', async () => {
    const api = createDock();
    oneGroup(api);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    api.getPanel('t2')!.api.close();
    await waitClose();
    await flushMicrotasks();

    expect(api.getPanel('t2')).toBeUndefined();
    expect(document.activeElement).toBe(outside);
  });
});

describe('关掉整组后 MRU 回落的面板获焦(不限终端)', () => {
  it('editor | t:关掉 t 所在组 → 编辑器所在组激活,编辑器内容获焦', async () => {
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'editor' });
    api.addPanel({ id: 't', component: 'terminal', title: 't', position: { referencePanel: 'editor', direction: 'right' } });
    const tracker = trackGroupMru(api);
    api.getPanel('editor')!.api.setActive();
    api.getPanel('t')!.api.setActive();
    editableOf('t').focus();

    api.getPanel('t')!.api.close();
    await waitClose();
    await flushMicrotasks();

    expect(api.activePanel?.id).toBe('editor');
    expect(document.activeElement).toBe(editableOf('editor'));
    tracker.dispose();
  });

  it('焦点在组外(如 agent 关掉终端时用户在 Explorer)→ 只换活动组,不抢焦点', async () => {
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'editor' });
    api.addPanel({ id: 't', component: 'terminal', title: 't', position: { referencePanel: 'editor', direction: 'right' } });
    const tracker = trackGroupMru(api);
    api.getPanel('editor')!.api.setActive();
    api.getPanel('t')!.api.setActive();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    api.getPanel('t')!.api.close();
    await waitClose();
    await flushMicrotasks();

    expect(api.activePanel?.id).toBe('editor');
    expect(document.activeElement).toBe(outside);
    tracker.dispose();
  });
});
