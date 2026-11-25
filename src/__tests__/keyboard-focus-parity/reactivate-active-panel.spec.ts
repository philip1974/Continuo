// @vitest-environment jsdom
// BDD:再次激活「已是活动组里的活动面板」不重挂面板内容 —— 面板内容里的焦点(如编辑器 tab 行上键盘 Enter / Space
// 激活的 tab)不掉到 body。dockview 6 对已活动面板 setActive 仍 openPanel → renderPanel(把内容 DOM 摘下再挂回)。
// 面板不活动 / 所在组不是活动组时照常激活。见同目录 README 第 7 条。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import { activateDockPanel, wrapPanelClose } from '@/shell/dock/wrap-panel-close';
import { useClosingStore } from '@/stores/closing.store';
import { EXIT_DURATION_MS } from '@/shell/motion/tokens';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** 真实 dockview;每个面板内容里放一个可聚焦的按钮(编辑器 tab 行里 tab 的替身)。 */
function createDock(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: (opts) => {
      const element = document.createElement('div');
      const control = document.createElement('button');
      control.dataset.panel = opts.id;
      element.appendChild(control);
      return { element, init: () => {} };
    },
  });
  dock.api.onDidAddPanel((p) => wrapPanelClose(p));
  dock.api.onDidRemovePanel((p) => useClosingStore.getState().unmark(p.id));
  return dock.api;
}

const controlOf = (id: string) => document.querySelector<HTMLButtonElement>(`button[data-panel="${id}"]`)!;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('再次激活已活动的面板', () => {
  it('面板是活动组里的活动面板 → 焦点留在面板内容里的控件上(不重挂内容)', () => {
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'editor' });
    const panel = api.getPanel('editor')!;
    expect(panel.api.isActive).toBe(true);
    controlOf('editor').focus();

    activateDockPanel(panel);

    expect(document.activeElement).toBe(controlOf('editor'));
    expect(api.activePanel?.id).toBe('editor');
  });

  it('面板处于关闭 EXIT 动画窗口内 → 仍撤销排定的关闭(面板保留)', async () => {
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'editor' });
    api.addPanel({ id: 't1', component: 't', title: 't1', position: { referencePanel: 'editor', direction: 'within' } });
    api.getPanel('editor')!.api.setActive();
    api.getPanel('editor')!.api.close();
    expect(useClosingStore.getState().ids.has('editor')).toBe(true);

    activateDockPanel(api.getPanel('editor')!);
    await new Promise((r) => setTimeout(r, EXIT_DURATION_MS + 50));

    expect(api.getPanel('editor')).toBeDefined();
  });

  it('面板是组内活动面板但所在组不是活动组 → 激活该组', () => {
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'editor' });
    api.addPanel({ id: 't1', component: 't', title: 't1', position: { referencePanel: 'editor', direction: 'right' } });
    expect(api.activePanel?.id).toBe('t1');

    activateDockPanel(api.getPanel('editor')!);

    expect(api.activePanel?.id).toBe('editor');
    expect(api.getPanel('editor')!.api.isActive).toBe(true);
  });

  it('面板不是组内活动面板 → 切换为活动面板', () => {
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'editor' });
    api.addPanel({ id: 't1', component: 't', title: 't1', position: { referencePanel: 'editor', direction: 'within' } });
    expect(api.activePanel?.id).toBe('t1');

    activateDockPanel(api.getPanel('editor')!);

    expect(api.activePanel?.id).toBe('editor');
  });
});
