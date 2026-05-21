// terminal-panel-zoom — topic-22 iTerm2 风 Shift+Cmd+Enter zoom toggle。
//
// dockview 原生 maximizeGroup / exitMaximizedGroup 主路径,**guard-first**
// (codex red-team v2 P1-1):先验 activePanel 是 terminal + grid,不满足直接
// return;只有满足才决定 exit 还是 maximize。这样 zoom 命令永远只作用于
// terminal panel,不会误退出别的 maximized group。
//
// location.type !== 'grid' 一句话覆盖 floating / popout / edge 4 种
// DockviewGroupLocation(red-team v2 P1-3)。

import type { DockviewApi } from 'dockview-react';

export function toggleActiveTerminalZoom(api: DockviewApi): void {
  const p = api.activePanel;
  if (!p) return;
  if (p.view.contentComponent !== 'terminal') return;
  if (p.api.location.type !== 'grid') return;
  if (api.hasMaximizedGroup()) {
    api.exitMaximizedGroup();
  } else {
    api.maximizeGroup(p);
  }
}
