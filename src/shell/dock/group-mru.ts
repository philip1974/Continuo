// dock 组的最近使用(MRU)顺序:移除活动组后激活最近使用的组,popout 子窗关闭后收回的面板获焦。
//
// dockview 移除活动组(关掉组里最后一个面板 / 关闭 popout 子窗)时一律激活 groups[0](最早建的组),焦点跳到
// 不相干的地方。VSCode:关闭编辑器组后激活最近使用的组;辅助窗口关闭、编辑器收回主窗后获得焦点。
// dockview 在 onDidRemoveGroup 派发之后才检查「被移除的是否仍是活动组」再兜底 groups[0] —— 本模块在该事件里同步
// 激活目标,dockview 的兜底随之跳过。
//
// - 只在同一窗口内回落(VSCode 同):主窗关组不把活动组挪进 popout 子窗,反之亦然;同窗无候选 → 不干预。
// - 终端聚焦延到 microtask 且仅当目标仍是活动面板:拖动组里最后一个 tab 时 dockview(moveGroupOrPanel /
//   moveGroup)在 movingLock 之外 doRemoveGroup(skipActive),onDidRemoveGroup 照常派发,随后它自己把目标组设为
//   活动组(不移 DOM 焦点)—— 同步聚焦会把键盘焦点送进不相干的终端。setActive 仍同步,以压住 groups[0] 兜底。

import type { DockviewApi, IDockviewGroupPanel, IDockviewPanel } from 'dockview-react';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { focusTerminalPanel } from '@/panels/Terminal/terminal-panel-handles';
import { activateDockPanel } from './wrap-panel-close';

type Group = DockviewApi['groups'][number];

/** 组所在窗口:popout 组各占一个子窗;grid / floating 同在主窗。 */
const windowKeyOf = (group: Pick<IDockviewGroupPanel, 'id' | 'api'>): string => (group.api.location.type === 'popout' ? `popout:${group.id}` : 'main');

export function trackGroupMru(api: DockviewApi): { dispose: () => void } {
  // 组 id,最近使用在前。
  const mru: string[] = [];
  // 每个组最后的活动面板(popout 组关闭时面板已挪回引用组,组里查不到,靠它找回)。
  const lastActivePanel = new Map<string, string>();

  const touch = (group: Group | undefined): void => {
    if (!group) return;
    const i = mru.indexOf(group.id);
    if (i === 0) return;
    if (i > 0) mru.splice(i, 1);
    mru.unshift(group.id);
  };

  let disposed = false;
  const activate = (panel: IDockviewPanel): void => {
    activateDockPanel(panel);
    if (panel.view.contentComponent !== TERMINAL_PANEL_TYPE) return;
    queueMicrotask(() => {
      if (!disposed && api.activePanel === panel) focusTerminalPanel(panel.id);
    });
  };

  const onRemove = (group: Group): void => {
    const wasActive = api.activeGroup === group;
    const wasPopout = group.api.location.type === 'popout';
    const windowKey = windowKeyOf(group);
    const i = mru.indexOf(group.id);
    if (i >= 0) mru.splice(i, 1);
    const lastPanelId = lastActivePanel.get(group.id);
    lastActivePanel.delete(group.id);

    // popout 子窗关闭:面板已收回主窗(引用组),让收回的活动面板获焦。
    if (wasPopout && lastPanelId) {
      const returned = api.getPanel(lastPanelId);
      if (returned && returned.group !== group) {
        activate(returned);
        return;
      }
    }
    if (!wasActive) return;
    for (const id of mru) {
      const candidateGroup = api.getGroup(id);
      if (!candidateGroup || windowKeyOf(candidateGroup) !== windowKey) continue;
      const candidate = candidateGroup.activePanel;
      if (candidate) {
        activate(candidate);
        return;
      }
    }
  };

  const subs = [
    api.onDidActiveGroupChange(touch),
    api.onDidActivePanelChange((panel) => {
      if (!panel) return;
      lastActivePanel.set(panel.group.id, panel.id);
      touch(panel.group);
    }),
    api.onDidRemoveGroup(onRemove),
  ];
  touch(api.activeGroup);

  return {
    dispose: () => {
      disposed = true;
      for (const s of subs) s.dispose();
      mru.length = 0;
      lastActivePanel.clear();
    },
  };
}
