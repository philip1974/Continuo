// @vitest-environment jsdom
// BDD:每个组的活动 tab 总在 tab 条可见区内(不被挤进「⌄N」溢出菜单看不到);窄组里也至少露出活动 tab 标题。
// 见同目录 README 第 4 条。
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { revealActiveTab, trackActiveTabReveal } from '@/shell/dock/reveal-active-tab';
import { createDock } from './dock-fixtures';

const TAB_WIDTH = 80;

/** jsdom 无布局:给 tab 条与各 tab 一套可控几何(tab 依序排,每个 TAB_WIDTH 宽)。 */
function stubGeometry(list: HTMLElement, viewWidth: number): void {
  let scrollLeft = 0;
  Object.defineProperty(list, 'clientWidth', { configurable: true, get: () => viewWidth });
  Object.defineProperty(list, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (v: number) => {
      scrollLeft = v;
    },
  });
  for (const el of list.querySelectorAll<HTMLElement>(':scope > .dv-tab')) {
    Object.defineProperty(el, 'offsetLeft', {
      configurable: true,
      get: () => [...list.children].indexOf(el) * TAB_WIDTH,
    });
    Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => TAB_WIDTH });
  }
}

function tabStrip(activeIndex: number, count: number): HTMLElement {
  const list = document.createElement('div');
  list.className = 'dv-tabs-container';
  for (let i = 0; i < count; i++) {
    const tab = document.createElement('div');
    tab.className = i === activeIndex ? 'dv-tab dv-active-tab' : 'dv-tab dv-inactive-tab';
    list.appendChild(tab);
  }
  return list;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('revealActiveTab', () => {
  it('活动 tab 在可见区右侧外 → 滚到其右缘贴可见区右缘', () => {
    const list = tabStrip(3, 4);
    stubGeometry(list, 100);
    revealActiveTab(list);
    expect(list.scrollLeft).toBe(3 * TAB_WIDTH + TAB_WIDTH - 100);
  });

  it('活动 tab 在可见区左侧外 → 滚到其起点', () => {
    const list = tabStrip(0, 4);
    stubGeometry(list, 100);
    list.scrollLeft = 200;
    revealActiveTab(list);
    expect(list.scrollLeft).toBe(0);
  });

  it('已完全可见 → 不动', () => {
    const list = tabStrip(1, 4);
    stubGeometry(list, 200);
    list.scrollLeft = 40;
    revealActiveTab(list);
    expect(list.scrollLeft).toBe(40);
  });

  it('可见区比 tab 还窄 → 对齐 tab 起点(至少露出标题开头)', () => {
    const list = tabStrip(2, 3);
    stubGeometry(list, 30);
    revealActiveTab(list);
    expect(list.scrollLeft).toBe(2 * TAB_WIDTH);
  });
});

describe('trackActiveTabReveal(真实 dockview)', () => {
  const frames: Array<() => void> = [];
  const runFrames = () => {
    while (frames.length) frames.shift()!();
  };

  it('切换活动面板 / 组尺寸变化后的下一帧,活动 tab 被滚入可见区', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const dock = createDock();
    const api = dock.api as DockviewApi;
    for (const id of ['a', 'b', 'c', 'd']) api.addPanel({ id, component: 'x', title: id });
    const tracker = trackActiveTabReveal(api);
    const list = api.getPanel('a')!.group.element.querySelector<HTMLElement>('.dv-tabs-container')!;
    stubGeometry(list, 100);
    api.getPanel('a')!.api.setActive();
    runFrames();

    api.getPanel('d')!.api.setActive();
    list.scrollLeft = 0; // dockview 自己按 0 宽算错 / 没滚
    runFrames();
    expect(list.scrollLeft).toBe(4 * TAB_WIDTH - 100);

    // 组变窄后(窗口缩放 / 分屏)重新校正
    list.scrollLeft = 0;
    api.getPanel('d')!.group.api.setSize({ width: 300 });
    api.layout(300, 400, true);
    runFrames();
    expect(list.scrollLeft).toBe(4 * TAB_WIDTH - 100);
    tracker.dispose();
  });
});

describe('窄组样式:单个活动 tab 可收缩、标题截断', () => {
  const css = readFileSync('src/styles/dockview.css', 'utf8');
  it('组内唯一的活动 tab 可收缩(不被挤出 tab 条)', () => {
    expect(css).toMatch(/\.dv-tab\.dv-active-tab:only-child\s*\{[^}]*flex-shrink:\s*1/);
  });
  it('极窄组(容器查询)让出 tab 内边距、关闭与弹出按钮的宽度给标题', () => {
    expect(css).toMatch(/\.dv-tabs-and-actions-container\s*\{[^}]*container-type:\s*inline-size/);
    const narrow = css.slice(css.indexOf('@container'));
    expect(narrow).toMatch(/\[data-tab-close\]/);
    expect(narrow).toMatch(/\[data-dock-popout\]/);
    expect(readFileSync('src/shell/motion/SharedTab.tsx', 'utf8')).toMatch(/data-tab-close/);
    expect(readFileSync('src/shell/dock/HeaderActions.tsx', 'utf8')).toMatch(/data-dock-popout/);
  });
  it('SharedTab 标题可截断', () => {
    const src = readFileSync('src/shell/motion/SharedTab.tsx', 'utf8');
    expect(src).toMatch(/truncate/);
  });
});
