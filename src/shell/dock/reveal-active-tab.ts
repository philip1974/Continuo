// 每个组的活动 tab 总在 tab 条可见区内(VSCode:活动编辑器 tab 总可见,不会被挤进溢出菜单看不到)。
//
// dockview 只在 setActivePanel 那一刻按「各 tab clientWidth 累加」滚一次 tab 条:面板尚未布局(宽度 0,如新建 /
// 刚恢复)时算错,之后组变窄(窗口缩放 / 分屏)也不再校正 → 活动 tab 留在可见区外、只进「⌄N」溢出菜单。
// 这里在活动面板变化与组尺寸变化后的下一帧(布局已完成)按实际几何把活动 tab 滚入可见区;tab 条滚动后 dockview
// 自己的 scroll 监听会重算溢出菜单。

import type { DockviewApi } from 'dockview-react';

type Group = DockviewApi['groups'][number];

/**
 * 把 tab 条(`.dv-tabs-container`,position:relative → tab 的 offsetLeft 相对于它)里的活动 tab 滚入可见区。
 * tab 比可见区还宽时对齐其起点(至少露出标题开头)。
 */
export function revealActiveTab(tabsList: HTMLElement): void {
  const tab = tabsList.querySelector<HTMLElement>(':scope > .dv-tab.dv-active-tab');
  if (!tab) return;
  const start = tab.offsetLeft;
  const end = start + tab.offsetWidth;
  const viewStart = tabsList.scrollLeft;
  const viewEnd = viewStart + tabsList.clientWidth;
  if (start >= viewStart && end <= viewEnd) return;
  tabsList.scrollLeft = start < viewStart ? start : Math.max(0, Math.min(start, end - tabsList.clientWidth));
}

function tabsListOf(group: Group): HTMLElement | null {
  return group.element.querySelector<HTMLElement>('.dv-tabs-container');
}

export function trackActiveTabReveal(api: DockviewApi): { dispose: () => void } {
  const pending = new Set<Group>();
  let raf = 0;
  const flush = (): void => {
    raf = 0;
    const groups = [...pending];
    pending.clear();
    const live = new Set(api.groups);
    for (const group of groups) {
      if (!live.has(group)) continue;
      const list = tabsListOf(group);
      if (list) revealActiveTab(list);
    }
  };
  const schedule = (group: Group | undefined): void => {
    if (!group) return;
    pending.add(group);
    if (!raf) raf = requestAnimationFrame(flush);
  };

  const watched = new Map<Group, { dispose: () => void }>();
  const watch = (group: Group): void => {
    if (watched.has(group)) return;
    watched.set(group, group.api.onDidDimensionsChange(() => schedule(group)));
    schedule(group);
  };
  const unwatch = (group: Group): void => {
    watched.get(group)?.dispose();
    watched.delete(group);
    pending.delete(group);
  };

  const subs = [
    api.onDidActivePanelChange((panel) => schedule(panel?.group)),
    // 不抢激活地加入的面板(agent 终端等)成为其组的活动 tab,但全局活动面板不变,不触发上一条。
    api.onDidAddPanel((panel) => schedule(panel.group)),
    api.onDidAddGroup(watch),
    api.onDidRemoveGroup(unwatch),
  ];
  for (const group of api.groups) watch(group);

  return {
    dispose: () => {
      for (const s of subs) s.dispose();
      for (const d of watched.values()) d.dispose();
      watched.clear();
      pending.clear();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
