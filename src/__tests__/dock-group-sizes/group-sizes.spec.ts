// @vitest-environment jsdom
// BDD:只用鼠标调整 dock 组大小(对齐 VSCode 编辑器组,见同目录 README):
//   1. 双击两组之间的分隔条 → 该分隔条所在那一排等分;
//   2. 双击 tab 切换组大小(doubleClickTabToToggleEditorGroupSizes 默认 expand):未展开 → 展开(其它组缩到最小),已展开 → 全部等分;
//   3. 最大化组 / 取消最大化组(dockview 原生最大化);只有一个组时不可用;
//   4. 改动经 onDidLayoutChange 通知(布局持久化)。
// 真实 dockview(jsdom 无布局引擎:dock.layout 给定网格尺寸,dockview 自行按 splitview 计算各组尺寸)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import {
  canMaximizeGroup,
  distributeSashSizes,
  isGroupExpanded,
  toggleExpandGroup,
  toggleMaximizeGroup,
  trackSashReset,
} from '@/shell/dock/group-sizes';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createDock(): { api: DockviewApi; dock: DockviewComponent } {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
  });
  return { api: dock.api, dock };
}

/** 三列:a | b | c,宽 1200;再把 a 拖宽、c 拖窄成不等宽。 */
function threeColumns() {
  const { api, dock } = createDock();
  api.addPanel({ id: 'a', component: 'x', title: 'A' });
  api.addPanel({ id: 'b', component: 'x', title: 'B', position: { referencePanel: 'a', direction: 'right' } });
  api.addPanel({ id: 'c', component: 'x', title: 'C', position: { referencePanel: 'b', direction: 'right' } });
  dock.layout(1200, 600);
  api.getPanel('a')!.group.api.setSize({ width: 700 });
  return { api, dock };
}

const widthOf = (api: DockviewApi, id: string) => api.getPanel(id)!.group.api.width;
const heightOf = (api: DockviewApi, id: string) => api.getPanel(id)!.group.api.height;
const groupOf = (api: DockviewApi, id: string) => api.getPanel(id)!.group;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('双击分隔条 → 该排等分', () => {
  it('三列不等宽,双击任一分隔条 → 三列等宽,并通知布局变化', () => {
    const { api } = threeColumns();
    expect(widthOf(api, 'a')).toBeGreaterThan(widthOf(api, 'c') + 100);
    const onLayout = vi.fn();
    api.onDidLayoutChange(onLayout);
    const sashes = document.querySelectorAll('.dv-sash');
    expect(sashes.length).toBeGreaterThan(0);
    expect(distributeSashSizes(api, sashes[0])).toBe(true);
    expect(Math.abs(widthOf(api, 'a') - widthOf(api, 'b'))).toBeLessThanOrEqual(1);
    expect(Math.abs(widthOf(api, 'b') - widthOf(api, 'c'))).toBeLessThanOrEqual(1);
    return new Promise<void>((r) => setTimeout(r)).then(() => expect(onLayout).toHaveBeenCalled());
  });

  it('只等分双击的那一排:右列上下拆分后,双击上下之间的分隔条只等分上下,左右宽度不变', () => {
    const { api, dock } = createDock();
    api.addPanel({ id: 'a', component: 'x', title: 'A' });
    api.addPanel({ id: 'b', component: 'x', title: 'B', position: { referencePanel: 'a', direction: 'right' } });
    api.addPanel({ id: 'd', component: 'x', title: 'D', position: { referencePanel: 'b', direction: 'below' } });
    dock.layout(1200, 600);
    groupOf(api, 'a').api.setSize({ width: 800 });
    groupOf(api, 'b').api.setSize({ height: 450 });
    const widthA = widthOf(api, 'a');
    // 右列内部(上下)的分隔条:在 b 所在 dv-branch-node 里
    const verticalSash = groupOf(api, 'b').element.closest('.dv-branch-node')!.querySelector('.dv-sash')!;
    expect(distributeSashSizes(api, verticalSash)).toBe(true);
    expect(Math.abs(heightOf(api, 'b') - heightOf(api, 'd'))).toBeLessThanOrEqual(1);
    expect(widthOf(api, 'a')).toBe(widthA);
  });

  it('不是网格分隔条的元素 → 不动(false)', () => {
    const { api } = threeColumns();
    const before = widthOf(api, 'a');
    expect(distributeSashSizes(api, document.createElement('div'))).toBe(false);
    expect(widthOf(api, 'a')).toBe(before);
  });

  it('trackSashReset:真实 dblclick 落在分隔条上 → 等分;落在别处不动;dispose 后不再处理', () => {
    const { api } = threeColumns();
    const sub = trackSashReset(api);
    const before = widthOf(api, 'a');
    groupOf(api, 'a').element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(widthOf(api, 'a')).toBe(before);
    document.querySelector('.dv-sash')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(Math.abs(widthOf(api, 'a') - widthOf(api, 'c'))).toBeLessThanOrEqual(1);
    sub.dispose();
    groupOf(api, 'a').api.setSize({ width: 700 });
    const skewed = widthOf(api, 'a');
    document.querySelector('.dv-sash')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(widthOf(api, 'a')).toBe(skewed);
  });
});

describe('双击 tab → 切换组大小(展开 / 等分)', () => {
  it('未展开 → 展开:其它组缩到最小;再次 → 全部等分', () => {
    const { api } = threeColumns();
    const b = groupOf(api, 'b');
    expect(isGroupExpanded(api, b)).toBe(false);
    expect(toggleExpandGroup(api, b)).toBe(true);
    expect(isGroupExpanded(api, b)).toBe(true);
    expect(widthOf(api, 'a')).toBe(groupOf(api, 'a').minimumWidth);
    expect(widthOf(api, 'c')).toBe(groupOf(api, 'c').minimumWidth);
    expect(widthOf(api, 'b')).toBeGreaterThan(900);

    expect(toggleExpandGroup(api, b)).toBe(true);
    expect(isGroupExpanded(api, b)).toBe(false);
    expect(Math.abs(widthOf(api, 'a') - widthOf(api, 'b'))).toBeLessThanOrEqual(1);
    expect(Math.abs(widthOf(api, 'b') - widthOf(api, 'c'))).toBeLessThanOrEqual(1);
  });

  it('嵌套:展开右列下方的组 → 左列宽度缩到最小、同列上方的组高度缩到最小', () => {
    const { api, dock } = createDock();
    api.addPanel({ id: 'a', component: 'x', title: 'A' });
    api.addPanel({ id: 'b', component: 'x', title: 'B', position: { referencePanel: 'a', direction: 'right' } });
    api.addPanel({ id: 'd', component: 'x', title: 'D', position: { referencePanel: 'b', direction: 'below' } });
    dock.layout(1200, 600);
    expect(toggleExpandGroup(api, groupOf(api, 'd'))).toBe(true);
    expect(widthOf(api, 'a')).toBe(groupOf(api, 'a').minimumWidth);
    expect(heightOf(api, 'b')).toBe(groupOf(api, 'b').minimumHeight);
  });

  it('只有一个组 → 不动(false)', () => {
    const { api, dock } = createDock();
    api.addPanel({ id: 'a', component: 'x', title: 'A' });
    api.addPanel({ id: 'a2', component: 'x', title: 'A2' });
    dock.layout(1200, 600);
    expect(toggleExpandGroup(api, groupOf(api, 'a'))).toBe(false);
  });
});

describe('最大化组 / 取消最大化组', () => {
  it('多个组时可用:最大化 → isMaximized;再次 → 取消', () => {
    const { api } = threeColumns();
    const b = groupOf(api, 'b');
    expect(canMaximizeGroup(api, b)).toBe(true);
    toggleMaximizeGroup(api, b);
    expect(b.api.isMaximized()).toBe(true);
    toggleMaximizeGroup(api, b);
    expect(b.api.isMaximized()).toBe(false);
    expect(api.hasMaximizedGroup()).toBe(false);
  });

  it('只有一个组 → 不可用,也不最大化', () => {
    const { api, dock } = createDock();
    api.addPanel({ id: 'a', component: 'x', title: 'A' });
    dock.layout(1200, 600);
    const a = groupOf(api, 'a');
    expect(canMaximizeGroup(api, a)).toBe(false);
    toggleMaximizeGroup(api, a);
    expect(a.api.isMaximized()).toBe(false);
  });

  it('浮动组不可最大化', () => {
    const { api } = threeColumns();
    api.addPanel({ id: 'f', component: 'x', title: 'F', floating: true });
    expect(canMaximizeGroup(api, groupOf(api, 'f'))).toBe(false);
  });
});
