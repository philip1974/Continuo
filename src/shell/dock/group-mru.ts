// dock 组的最近使用(MRU)顺序:移除活动组后激活最近使用的组,popout 子窗关闭后收回的面板获焦。
//
// dockview 移除活动组(关掉组里最后一个面板 / 关闭 popout 子窗)时一律激活 groups[0](最早建的组),焦点跳到
// 不相干的地方。VSCode:关闭编辑器组后激活最近使用的组;辅助窗口关闭、编辑器收回主窗后获得焦点。
// dockview 在 onDidRemoveGroup 派发之后才检查「被移除的是否仍是活动组」再兜底 groups[0] —— 本模块在该事件里同步
// 激活目标,dockview 的兜底随之跳过。
//
// - popout 收回的面板总获焦(焦点原在已关闭的子窗里);关活动组时仅当焦点原在该组里才把焦点交给回落的面板。
// - 只在同一窗口内回落(VSCode 同):主窗关组不把活动组挪进 popout 子窗,反之亦然;同窗无候选 → 不干预。
// - 回落的面板(终端 / 编辑器等)获焦,聚焦延到 microtask 且仅当目标仍是活动面板:拖动组里最后一个 tab 时 dockview(moveGroupOrPanel /
//   moveGroup)在 movingLock 之外 doRemoveGroup(skipActive),onDidRemoveGroup 照常派发,随后它自己把目标组设为
//   活动组(不移 DOM 焦点)—— 同步聚焦会把键盘焦点送进不相干的终端。setActive 仍同步,以压住 groups[0] 兜底。

import type { DockviewApi, IDockviewGroupPanel, IDockviewPanel } from 'dockview-react';
import { activateDockPanel } from './wrap-panel-close';
import { focusWithinOrLost } from '@/design/focus-within-or-lost';
import { focusDockPanelSoon } from './panel-focus';

type Group = DockviewApi['groups'][number];

/** 组所在窗口:popout 组各占一个子窗;grid / floating 同在主窗。 */
const windowKeyOf = (group: Pick<IDockviewGroupPanel, 'id' | 'api'>): string => (group.api.location.type === 'popout' ? `popout:${group.id}` : 'main');

// 每个 dock api 的组 MRU(trackGroupMru 期间有效),供 mostRecentMainWindowPanel 查询。
const mruByApi = new WeakMap<DockviewApi, readonly string[]>();

/**
 * 主窗(grid / floating)里最近使用的组的活动面板:活动面板在 popout 子窗时,主窗的命令(F6)用它代替活动面板。
 * 未跟踪 MRU 的组排在后面(按 dockview 组顺序)。主窗没有带面板的组 → undefined。
 */
export function mostRecentMainWindowPanel(api: DockviewApi): IDockviewPanel | undefined {
  const recent = (mruByApi.get(api) ?? []).map((id) => api.getGroup(id));
  for (const group of [...recent, ...api.groups]) {
    if (group && windowKeyOf(group) === 'main' && group.activePanel) return group.activePanel;
  }
  return undefined;
}

export function trackGroupMru(api: DockviewApi): { dispose: () => void } {
  // 组 id,最近使用在前。
  const mru: string[] = [];
  mruByApi.set(api, mru);
  // 每个组最后的活动面板(popout 组关闭时面板已挪回引用组,组里查不到,靠它找回)。
  const lastActivePanel = new Map<string, string>();

  const touch = (group: Group | undefined): void => {
    if (!group) return;
    // 弹出到子窗时 dockview 把 popout 组设为活动组,活动面板仍是同一对象 → 不派发 onDidActivePanelChange;
    // 在活动组变化时也记下组的活动面板,否则子窗关闭时找不到要收回获焦的面板。
    if (group.activePanel) lastActivePanel.set(group.id, group.activePanel.id);
    const i = mru.indexOf(group.id);
    if (i === 0) return;
    if (i > 0) mru.splice(i, 1);
    mru.unshift(group.id);
  };

  let disposed = false;
  const activate = (panel: IDockviewPanel, focus: boolean): void => {
    activateDockPanel(panel);
    if (focus) focusDockPanelSoon(panel, () => !disposed && api.activePanel === panel);
  };

  const onRemove = (group: Group): void => {
    const wasActive = api.activeGroup === group;
    const wasPopout = group.api.location.type === 'popout';
    const windowKey = windowKeyOf(group);
    // 焦点原本在被移除的组里(组已卸载 → 落到 body)才把焦点交给回落的面板;焦点在组外(如 agent 关掉终端时
    // 用户在 Explorer 里)只换活动组、不抢焦点。
    const focusWasInGroup = focusWithinOrLost(group.element.ownerDocument, group.element);
    const i = mru.indexOf(group.id);
    if (i >= 0) mru.splice(i, 1);
    const lastPanelId = lastActivePanel.get(group.id);
    lastActivePanel.delete(group.id);

    // popout 子窗关闭:面板已收回主窗(引用组),让收回的活动面板获焦。
    if (wasPopout && lastPanelId) {
      const returned = api.getPanel(lastPanelId);
      if (returned && returned.group !== group) {
        activate(returned, true);
        return;
      }
    }
    if (!wasActive) return;
    // 组里的活动面板仍在、只是随组挪走了(浮动组弹出到子窗:面板先挪进新组再移除本组)→ 焦点随面板走:激活它本身
    //(压住 groups[0] 兜底),不回落到同窗别的面板 —— 终端一被设为活动就自己抢焦点。聚焦由挪动方负责。
    const moved = lastPanelId ? api.getPanel(lastPanelId) : undefined;
    if (moved && moved.group !== group) {
      activateDockPanel(moved);
      return;
    }
    for (const id of mru) {
      const candidateGroup = api.getGroup(id);
      if (!candidateGroup || windowKeyOf(candidateGroup) !== windowKey) continue;
      const candidate = candidateGroup.activePanel;
      if (candidate) {
        activate(candidate, focusWasInGroup);
        return;
      }
    }
  };

  const subs = [
    api.onDidActiveGroupChange(touch),
    api.onDidActivePanelChange((panel) => {
      if (panel) touch(panel.group);
    }),
    api.onDidRemoveGroup(onRemove),
  ];
  touch(api.activeGroup);

  return {
    dispose: () => {
      disposed = true;
      if (mruByApi.get(api) === mru) mruByApi.delete(api);
      for (const s of subs) s.dispose();
      mru.length = 0;
      lastActivePanel.clear();
    },
  };
}
