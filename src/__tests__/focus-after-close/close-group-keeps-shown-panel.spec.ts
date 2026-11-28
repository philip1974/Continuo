// @vitest-environment jsdom
// BDD:关闭编辑器组后焦点移到最近使用的组,但不切走该 dock 组正显示的面板(冲突比较 / 设置页 / 终端)。
// VSCode:关闭编辑器组后激活 MRU 组,该组正显示的编辑器不变。见同目录 README 第 2 条。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import { activateGroupKeepingShown } from '@/shell/dock/group-mru';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createDock(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
  });
  return dock.api;
}

let api: DockviewApi | null = null;
afterEach(() => {
  api?.dispose();
  api = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** 左组:编辑器组 g1;右组:编辑器组 g2 + 同组叠放的 other(正显示 other);活动组是左组。 */
function layout(): DockviewApi {
  api = createDock();
  api.addPanel({ id: 'g1', component: 'editor' });
  const g2 = api.addPanel({ id: 'g2', component: 'editor', position: { referencePanel: 'g1', direction: 'right' } });
  api.addPanel({ id: 'other', component: 'conflict-diff', position: { referencePanel: g2.id, direction: 'within' } });
  api.getPanel('g1')!.api.setActive();
  return api;
}

describe('activateGroupKeepingShown', () => {
  it('同组正显示别的面板 → 激活那个面板(组成为活动组),不把编辑器组面板切到前面', () => {
    const dock = layout();
    const g2 = dock.getPanel('g2')!;
    expect(g2.group.activePanel?.id).toBe('other');
    const shown = activateGroupKeepingShown(g2);
    expect(shown.id).toBe('other');
    expect(dock.activeGroup).toBe(g2.group);
    expect(dock.activePanel?.id).toBe('other');
    expect(g2.group.activePanel?.id).toBe('other');
  });

  it('编辑器组面板就是该组正显示的面板 → 激活它并返回它', () => {
    const dock = layout();
    const g2 = dock.getPanel('g2')!;
    g2.api.setActive();
    dock.getPanel('g1')!.api.setActive();
    const shown = activateGroupKeepingShown(g2);
    expect(shown).toBe(g2);
    expect(dock.activePanel?.id).toBe('g2');
  });
});
