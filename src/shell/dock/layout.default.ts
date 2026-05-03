import type { DockviewApi } from 'dockview-react';

// 命令式构建默认布局,而非猜 SerializedDockview 形状。
// 布局:左 explorer | 右(上 editor / 下 terminal+output 同 group)
export function applyDefaultLayout(api: DockviewApi) {
  const explorer = api.addPanel({
    id: 'explorer',
    component: 'explorer',
    title: 'Explorer',
  });

  const editor = api.addPanel({
    id: 'editor',
    component: 'editor',
    title: 'Editor',
    position: { referencePanel: explorer.id, direction: 'right' },
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
