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

/**
 * 主窗正显示的活动面板:活动面板在主窗 → 它;活动面板在 popout 子窗 → 主窗最近使用的组的活动面板(主窗的标题栏 / 状态栏、
 * 主窗入口的 toggle 都按它判断)。
 */
export function mainWindowActivePanel(api: DockviewApi): IDockviewPanel | undefined {
  const panel = api.activePanel;
  return panel?.api.location.type === 'popout' ? mostRecentMainWindowPanel(api) : panel;
}

/**
 * 从主窗入口(齿轮 / 菜单 / 命令 / 快捷键)新建面板的落点。dockview 缺省落进活动组,活动组在 popout 子窗时新面板会出现在
 * 子窗里(用户在主窗里看不到)。VSCode:在触发的窗口打开 → 活动组在主窗(grid / floating)时不干预(undefined);在
 * popout 时改投主窗最近使用的组;主窗没有带面板的组 → 取可见的 grid 组;都没有 → 在主窗 grid 新建一组。
 */
export function mainWindowAddPosition(
  api: DockviewApi,
): { referenceGroup: Group; direction: 'within' } | { direction: 'right' } | undefined {
  const active = api.activeGroup;
  if (!active || windowKeyOf(active) === 'main') return undefined;
  const group =
    mostRecentMainWindowPanel(api)?.group ??
    api.groups.find((g) => g.api.location.type === 'grid' && g.api.isVisible);
  return group ? { referenceGroup: group, direction: 'within' } : { direction: 'right' };
}

/**
 * 主窗(grid / floating)里没有面板:面板全在 popout 子窗(或全关光)。DockShell 据此显示主窗空态(VSCode:主窗保留
 * 带水印的空编辑器组),不能用 totalPanels(把子窗面板也算进去,主窗 dock 空白且 F6 不可达)。
 */
export function isMainWindowDockEmpty(api: Pick<DockviewApi, 'panels'>): boolean {
  return !api.panels.some((panel) => panel.api.location.type !== 'popout');
}

/**
 * 组内面板 MRU 的不变式:活动面板在组 MRU 的首位(VSCode EditorGroupModel:活动编辑器总是 MRU 第一个)。关掉活动面板时
 * dockview 激活组 MRU 的首个面板;而它每加入一个面板(含 fromJSON 按 tab 顺序恢复、后台加入不激活的面板)都把该面板放到 MRU
 * 首位 —— 恢复布局后不点 tab 就新建再关掉,会落到组里最后一个 tab;后台加入的终端也会插到活动面板前面。
 * dockview 无公开 API 调整组 MRU,只能调其 model 的 updateMru(私有,不改 tab 顺序、不派发事件、不动焦点 / 布局);
 * 升级后不存在则不干预。
 */
function keepActivePanelMruFirst(group: Group | undefined): void {
  const active = group?.activePanel;
  const model = (group as { model?: { updateMru?: (panel: IDockviewPanel) => void } } | undefined)?.model;
  if (active && typeof model?.updateMru === 'function') model.updateMru(active);
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

  // 从多面板组弹出活动面板时,dockview 在 movingLock 内 openPanel(顺带设为活动组,事件被 movingLock 吞掉),随后
  // doSetGroupAndPanelActive 因已是活动组直接返回 → 没有任何活动组 / 活动面板事件,touch 记不到 popout 组的活动面板,
  // 子窗关闭时收回的面板不获焦(主窗焦点留在 body)。组挂到子窗时 location 改为 popout(此时面板已挪入)→ 在此补记。
  const locationSubs = new Map<Group, { dispose: () => void }>();
  const watchLocation = (group: Group): void => {
    if (locationSubs.has(group)) return;
    locationSubs.set(
      group,
      group.api.onDidLocationChange(() => {
        if (group.api.location.type !== 'popout') return;
        if (api.activeGroup === group) touch(group);
        else if (group.activePanel) lastActivePanel.set(group.id, group.activePanel.id);
      }),
    );
  };

  const subs = [
    api.onDidActiveGroupChange(touch),
    api.onDidActivePanelChange((panel) => {
      if (panel) touch(panel.group);
    }),
    api.onDidRemoveGroup(onRemove),
    // 加入面板(后台加入不改活动面板)/ 加入组(popout 恢复时子窗挂上的组)后,活动面板重新置于组 MRU 首位
    api.onDidAddPanel((panel) => keepActivePanelMruFirst(panel.group)),
    api.onDidAddGroup((group) => {
      keepActivePanelMruFirst(group);
      watchLocation(group);
    }),
    api.onDidRemoveGroup((group) => {
      locationSubs.get(group)?.dispose();
      locationSubs.delete(group);
    }),
  ];
  for (const group of api.groups) watchLocation(group);
  touch(api.activeGroup);
  // 跟踪始于布局恢复(fromJSON / 默认布局)之后:恢复时按 tab 顺序加入的面板已把活动面板挤到 MRU 后面
  for (const group of api.groups) keepActivePanelMruFirst(group);

  return {
    dispose: () => {
      disposed = true;
      if (mruByApi.get(api) === mru) mruByApi.delete(api);
      for (const s of subs) s.dispose();
      for (const s of locationSubs.values()) s.dispose();
      locationSubs.clear();
      mru.length = 0;
      lastActivePanel.clear();
    },
  };
}
