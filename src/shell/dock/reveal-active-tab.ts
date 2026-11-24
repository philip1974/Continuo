// 每个组的活动 tab 总在 tab 条可见区内(VSCode:活动编辑器 tab 总可见,不会被挤进溢出菜单看不到)。
//
// dockview 只在 setActivePanel 那一刻按「各 tab clientWidth 累加」滚一次 tab 条:面板尚未布局(宽度 0,如新建 /
// 刚恢复)时算错,之后组变窄(窗口缩放 / 分屏)也不再校正 → 活动 tab 留在可见区外、只进「⌄N」溢出菜单。
// 这里在活动面板变化与 tab 条尺寸变化(ResizeObserver;组尺寸事件不一定伴随 tab 条变化)后的下一帧(布局已完成)按
// 实际几何把活动 tab 滚入可见区;tab 条滚动后 dockview 自己的 scroll 监听会重算溢出菜单。

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
  // dockview 默认的自绘滚动条(Scrollbar)自己记一份滚动偏移,只在 tab 条的 scroll 事件里同步;而它在 tab 条 resize
  // 后的下一帧按这份偏移重设 scrollLeft。浏览器的 scroll 事件是异步派发的,赶不上那次重设 → 刚滚入的活动 tab 被滚回
  // 原位(窗口缩窄时 scrollLeft 一直是 0)。同步派发一次 scroll 让它立即记下新偏移(溢出菜单也随之重算)。
  tabsList.dispatchEvent(new Event('scroll'));
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
    const list = tabsListOf(group);
    const dimensions = group.api.onDidDimensionsChange(() => schedule(group));
    const observer =
      list && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => schedule(group)) : null;
    if (list) observer?.observe(list);
    watched.set(group, {
      dispose: () => {
        dimensions.dispose();
        if (list) observer?.unobserve(list);
        observer?.disconnect();
      },
    });
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
