import type { DockviewApi } from 'dockview-react';

// Explorer 固定在左侧 sidebar(App.tsx 内的 ExplorerSidebar),不参与 Dockview。
// 默认布局:editor 占主区,下方 terminal+output 同 group。
export function applyDefaultLayout(api: DockviewApi) {
  const editor = api.addPanel({
    id: 'editor',
    component: 'editor',
    title: 'Editor',
  });

  const terminal = api.addPanel({
    id: 'terminal',
    component: 'terminal',
    title: 'Terminal',
    position: { referencePanel: editor.id, direction: 'below' },
  });

  api.addPanel({
    id: 'output',
    component: 'output',
    title: 'Output',
    position: { referenceGroup: terminal.group, direction: 'within' },
  });

  editor.api.setActive();
}
