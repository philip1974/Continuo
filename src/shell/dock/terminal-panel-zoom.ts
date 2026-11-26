// terminal-panel-zoom — topic-22 iTerm2 风 Shift+Cmd+Enter zoom toggle。
//
// dockview 原生 maximizeGroup / exitMaximizedGroup 主路径,**guard-first**
// (设计评审 P1-1):先验 activePanel 是 terminal + grid,不满足直接
// return;只有满足才决定 exit 还是 maximize。这样 zoom 命令永远只作用于
// terminal panel,不会误退出别的 maximized group。
//
// location.type !== 'grid' 一句话覆盖 floating / popout / edge 4 种
// DockviewGroupLocation(design review v2 P1-3)。
//
// 作用于触发它的窗口的活动面板(activePanelInDocument;VSCode:命令作用于触发它的窗口):全局 activePanel 在从子窗切回
// 主窗时可能仍是子窗的面板 → 主窗按 ⇧⌘Enter 没反应。

import type { DockviewApi } from 'dockview-react';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { activePanelInDocument } from './group-mru';
import { getCommandDocument } from './popout-documents';

export function toggleActiveTerminalZoom(api: DockviewApi): void {
  const p = activePanelInDocument(api, getCommandDocument());
  if (!p) return;
  if (p.view.contentComponent !== TERMINAL_PANEL_TYPE) return;
  if (p.api.location.type !== 'grid') return;
  if (api.hasMaximizedGroup()) {
    api.exitMaximizedGroup();
  } else {
    api.maximizeGroup(p);
  }
}
