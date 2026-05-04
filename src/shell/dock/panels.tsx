import type { IDockviewPanelProps } from 'dockview-react';
import { Editor } from '@/panels/Editor';
import { Terminal } from '@/panels/Terminal';
import { Output } from '@/panels/Output';
import { PanelMount } from '@/shell/motion/PanelMount';

// Explorer 固定在左侧 sidebar(VSCode 风),不参与 Dockview 拖拽,
// 所以这里不再注册 'explorer' component。
export type PanelKey = 'editor' | 'terminal' | 'output';

// dockview 通过 component 名字 → React FC 映射;PanelMount 包一层进出场动画。
export const panelComponents: Record<PanelKey, React.FC<IDockviewPanelProps>> = {
  editor: (p) => (
    <PanelMount panelId={p.api.id}>
      <Editor />
    </PanelMount>
  ),
  terminal: (p) => (
    <PanelMount panelId={p.api.id}>
      <Terminal />
    </PanelMount>
  ),
  output: (p) => (
    <PanelMount panelId={p.api.id}>
      <Output />
    </PanelMount>
  ),
};
