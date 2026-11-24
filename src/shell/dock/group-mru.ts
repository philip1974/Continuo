// dock 组的最近使用(MRU)顺序:移除活动组后激活最近使用的组,popout 子窗关闭后收回的面板获焦。
//
// dockview 移除活动组(关掉组里最后一个面板 / 关闭 popout 子窗)时一律激活 groups[0](最早建的组),焦点跳到
// 不相干的地方。VSCode:关闭编辑器组后激活最近使用的组;辅助窗口关闭、编辑器收回主窗后获得焦点。
// dockview 在 onDidRemoveGroup 派发之后才检查「被移除的是否仍是活动组」再兜底 groups[0] —— 本模块在该事件里同步
// 激活目标,dockview 的兜底随之跳过。

import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { focusTerminalPanel } from '@/panels/Terminal/terminal-panel-handles';
import { activateDockPanel } from './wrap-panel-close';

type Group = DockviewApi['groups'][number];

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

  const activate = (panel: IDockviewPanel): void => {
    activateDockPanel(panel);
    if (panel.view.contentComponent === TERMINAL_PANEL_TYPE) focusTerminalPanel(panel.id);
  };

  const onRemove = (group: Group): void => {
    const wasActive = api.activeGroup === group;
    const wasPopout = group.api.location.type === 'popout';
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
      const candidate = api.getGroup(id)?.activePanel;
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
      for (const s of subs) s.dispose();
      mru.length = 0;
      lastActivePanel.clear();
    },
  };
}
