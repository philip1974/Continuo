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
import { onPopoutRestoreSettled } from './popout-restore-settle';
import { isEditorGroupId } from '../../../electron/shared/editor-group-id';
import { isSidePanelGroup } from './side-panel';

type Group = DockviewApi['groups'][number];

/** 组所在窗口:popout 组各占一个子窗;grid / floating 同在主窗。 */
const windowKeyOf = (group: Pick<IDockviewGroupPanel, 'id' | 'api'>): string => (group.api.location.type === 'popout' ? `popout:${group.id}` : 'main');

// 每个 dock api 的组 MRU(trackGroupMru 期间有效),供 mostRecentMainWindowPanel 查询。
const mruByApi = new WeakMap<DockviewApi, readonly string[]>();
// 每个 dock api 的面板 MRU(面板 id,最近激活在前;trackGroupMru 期间有效),供 mostRecentPanelInDocument 查询。
const panelMruByApi = new WeakMap<DockviewApi, readonly string[]>();

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

/** doc 所在 popout 子窗的组(doc 是主窗文档 / 该子窗已不在 → undefined)。 */
export function popoutGroupOfDocument(api: DockviewApi, doc: Document): Group | undefined {
  return api.groups.find((group) => {
    const location = group.api.location;
    // 子窗关闭途中 dockview 的 getWindow() 可能已是 null(类型未标)
    return location.type === 'popout' && (location.getWindow() as Window | null)?.document === doc;
  });
}

/**
 * doc 所在窗口正显示的活动面板(窗口级命令作用的面板;VSCode:命令作用于触发它的窗口):主窗文档 → mainWindowActivePanel;
 * popout 子窗文档 → 该子窗组的活动面板(子窗已不在 → undefined)。不用全局 activePanel:用户从子窗切回主窗(点标题栏)时
 * 活动组仍是子窗的组,反之亦然。
 */
export function activePanelInDocument(api: DockviewApi, doc: Document): IDockviewPanel | undefined {
  return doc === document ? mainWindowActivePanel(api) : popoutGroupOfDocument(api, doc)?.activePanel;
}

/**
 * doc 所在窗口里满足 match 的最近激活的面板(⌃` 切换终端找最近使用的终端;BDD: src/__tests__/terminal-toggle/):按面板 MRU,
 * 从未激活过的按 dock 面板顺序排在后面。该窗口没有 → undefined。
 */
export function mostRecentPanelInDocument(
  api: DockviewApi,
  doc: Document,
  match: (panel: IDockviewPanel) => boolean,
): IDockviewPanel | undefined {
  const popout = doc === document ? undefined : popoutGroupOfDocument(api, doc);
  if (doc !== document && !popout) return undefined;
  const inWindow = (panel: IDockviewPanel): boolean => (popout ? panel.group === popout : windowKeyOf(panel.group) === 'main');
  const recent = (panelMruByApi.get(api) ?? []).map((id) => api.getPanel(id));
  for (const panel of [...recent, ...api.panels]) if (panel && inWindow(panel) && match(panel)) return panel;
  return undefined;
}

/** 编辑器组面板(面板 id = 编辑器组 id;BDD: src/__tests__/editor-groups/)。 */
const isEditorGroupPanel = (panel: IDockviewPanel): boolean =>
  isEditorGroupId(panel.id) && panel.view?.contentComponent === 'editor';

/**
 * doc 所在窗口的编辑器组(编辑器组类命令 ⌘\ / ⌘S / 关闭组中的编辑器… 作用的组;VSCode:命令作用于触发它的窗口的活动编辑器组):
 * 该窗口的活动面板是编辑器组 → 它;否则 preferred(活动编辑器组)在该窗口 → preferred;否则该窗口最近使用的组里的编辑器组;
 * 该窗口没有编辑器组(或子窗已不在)→ undefined。不用全局活动编辑器组:从子窗切回主窗时它可能仍在子窗,反之亦然。
 */
export function editorGroupInDocument(api: DockviewApi, doc: Document, preferred?: string): string | undefined {
  const popout = doc === document ? undefined : popoutGroupOfDocument(api, doc);
  if (doc !== document && !popout) return undefined;
  const inWindow = (group: Pick<IDockviewGroupPanel, 'id' | 'api'>): boolean => (popout ? group === popout : windowKeyOf(group) === 'main');
  const active = activePanelInDocument(api, doc);
  if (active && isEditorGroupPanel(active)) return active.id;
  const pref = preferred === undefined ? undefined : api.getPanel(preferred);
  if (pref && isEditorGroupPanel(pref) && inWindow(pref.group)) return pref.id;
  const recent = (mruByApi.get(api) ?? []).map((id) => api.getGroup(id));
  for (const group of [...recent, ...api.groups]) {
    if (!group || !inWindow(group)) continue;
    const panel = group.activePanel && isEditorGroupPanel(group.activePanel) ? group.activePanel : group.panels.find(isEditorGroupPanel);
    if (panel) return panel.id;
  }
  return undefined;
}

/**
 * 从主窗入口(齿轮 / 菜单 / 命令 / 快捷键)新建面板的落点。dockview 缺省落进活动组,活动组在 popout 子窗时新面板会出现在
 * 子窗里(用户在主窗里看不到)。VSCode:在触发的窗口打开 → 活动组在主窗(grid / floating)且可见时不干预(undefined);在
 * popout 时改投主窗最近使用的组;主窗没有带面板的组 → 取可见的 grid 组;都没有 → 在主窗 grid 新建一组。
 * 活动组是主窗里隐藏的 popout 引用组(整组弹出后 dockview 留在 grid 里的 0 宽空组;关掉主窗最后一个面板后 dockview 把它
 * 设为活动组)时同 popout 处理:加进去的面板主窗看不见。
 * 活动组是只含侧栏面板(搜索)的组时同样改投(VSCode:编辑器 / 面板不进侧栏;BDD: workspace-search 1a):候选跳过侧栏组;
 * 主窗没有别的组 → 在该侧栏组右侧新建一组。
 */
export function mainWindowAddPosition(
  api: DockviewApi,
): { referenceGroup: Group; direction: 'within' | 'right' } | { direction: 'right' } | undefined {
  const active = api.activeGroup;
  const activeInMain = !!active && windowKeyOf(active) === 'main' && active.api.isVisible;
  if (!active || (activeInMain && !isSidePanelGroup(active))) return undefined;
  const recent = (mruByApi.get(api) ?? []).map((id) => api.groups.find((g) => g.id === id));
  const group =
    [...recent, ...api.groups].find((g) => g && windowKeyOf(g) === 'main' && g.activePanel && !isSidePanelGroup(g)) ??
    api.groups.find((g) => g.api.location.type === 'grid' && g.api.isVisible && !isSidePanelGroup(g));
  if (group) return { referenceGroup: group, direction: 'within' };
  return activeInMain ? { referenceGroup: active, direction: 'right' } : { direction: 'right' };
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
  // 面板 id,最近激活在前(只记活动面板变化;面板移除时删掉,不随开关累积)。
  const panelMru: string[] = [];
  panelMruByApi.set(api, panelMru);
  const touchPanel = (panel: IDockviewPanel): void => {
    const i = panelMru.indexOf(panel.id);
    if (i === 0) return;
    if (i > 0) panelMru.splice(i, 1);
    panelMru.unshift(panel.id);
  };
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
  // popout 子窗获得焦点(切到子窗:点标题栏 / ⌘` / 点进内容)→ 其组成为活动组(VSCode:辅助窗口获焦时其编辑器组成为活动组)。
  // dockview 只在面板内容获焦时激活组(点标题栏、窗口切换都不会),此前活动组 / 活动面板停在主窗。
  const windowFocusSubs = new Map<Group, () => void>();
  const unwatchWindowFocus = (group: Group): void => {
    windowFocusSubs.get(group)?.();
    windowFocusSubs.delete(group);
  };
  const watchWindowFocus = (group: Group): void => {
    unwatchWindowFocus(group);
    const location = group.api.location;
    if (location.type !== 'popout') return;
    const win = location.getWindow() as Window | null;
    if (!win) return;
    const onFocus = (): void => {
      if (!disposed && api.activeGroup !== group && group.api.location.type === 'popout') group.api.setActive();
    };
    // 文档在挂监听时取:子窗关闭后 win.document 可能已不可用
    const doc = win.document;
    win.addEventListener('focus', onFocus);
    doc.addEventListener('focusin', onFocus);
    windowFocusSubs.set(group, () => {
      win.removeEventListener('focus', onFocus);
      doc.removeEventListener('focusin', onFocus);
    });
  };
  // 主窗获得焦点(从子窗切回:点标题栏 / ⌘`)而活动组在子窗 → 主窗最近使用的组成为活动组(与子窗获焦对称;只换活动组、
  // 不移 DOM 焦点)。此前切回主窗时焦点若不在面板内容里,活动组 / 活动编辑器组一直停在子窗,主窗的命令作用到子窗。
  const activateMainWindowGroup = (): void => {
    const active = api.activeGroup;
    if (disposed || !active || windowKeyOf(active) === 'main') return;
    mostRecentMainWindowPanel(api)?.group.api.setActive();
  };
  window.addEventListener('focus', activateMainWindowGroup);
  // 重启恢复:dockview 挂上 popout 子窗时把 popout 组设为活动组(addPopoutGroup 的 doSetGroupAndPanelActive),覆盖了 fromJSON
  // 恢复的主窗活动组 → 主窗标题 / 状态栏变成子窗的文件、活动编辑器组随之改成子窗的组并被写盘。恢复落定时改回主窗最近使用的组
  //(跟踪始于 fromJSON 之后,MRU 首位即恢复出的活动组);用户期间已切到该子窗(子窗有焦点)→ 不改。
  const offRestoreSettled = onPopoutRestoreSettled((settled) => {
    if (settled !== api) return;
    const location = api.activeGroup?.api.location;
    if (location?.type === 'popout' && (location.getWindow() as Window | null)?.document.hasFocus()) return;
    activateMainWindowGroup();
  });
  const watchLocation = (group: Group): void => {
    if (locationSubs.has(group)) return;
    watchWindowFocus(group);
    locationSubs.set(
      group,
      group.api.onDidLocationChange(() => {
        watchWindowFocus(group);
        if (group.api.location.type !== 'popout') return;
        if (api.activeGroup === group) touch(group);
        else if (group.activePanel) lastActivePanel.set(group.id, group.activePanel.id);
      }),
    );
  };

  const subs = [
    api.onDidActiveGroupChange(touch),
    api.onDidActivePanelChange((panel) => {
      if (!panel) return;
      touch(panel.group);
      touchPanel(panel);
    }),
    api.onDidRemoveGroup(onRemove),
    api.onDidRemovePanel((panel) => {
      const i = panelMru.indexOf(panel.id);
      if (i >= 0) panelMru.splice(i, 1);
    }),
    // 加入面板(后台加入不改活动面板)/ 加入组(popout 恢复时子窗挂上的组)后,活动面板重新置于组 MRU 首位
    api.onDidAddPanel((panel) => keepActivePanelMruFirst(panel.group)),
    api.onDidAddGroup((group) => {
      keepActivePanelMruFirst(group);
      watchLocation(group);
    }),
    api.onDidRemoveGroup((group) => {
      locationSubs.get(group)?.dispose();
      locationSubs.delete(group);
      unwatchWindowFocus(group);
    }),
  ];
  for (const group of api.groups) watchLocation(group);
  touch(api.activeGroup);
  if (api.activePanel) touchPanel(api.activePanel);
  // 跟踪始于布局恢复(fromJSON / 默认布局)之后:恢复时按 tab 顺序加入的面板已把活动面板挤到 MRU 后面
  for (const group of api.groups) keepActivePanelMruFirst(group);

  return {
    dispose: () => {
      disposed = true;
      window.removeEventListener('focus', activateMainWindowGroup);
      offRestoreSettled();
      if (mruByApi.get(api) === mru) mruByApi.delete(api);
      if (panelMruByApi.get(api) === panelMru) panelMruByApi.delete(api);
      for (const s of subs) s.dispose();
      for (const s of locationSubs.values()) s.dispose();
      locationSubs.clear();
      for (const off of windowFocusSubs.values()) off();
      windowFocusSubs.clear();
      mru.length = 0;
      panelMru.length = 0;
      lastActivePanel.clear();
    },
  };
}
