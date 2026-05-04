import type { IDockviewPanelProps } from 'dockview-react';
import { Explorer } from '@/panels/Explorer';
import { Editor } from '@/panels/Editor';
import { Terminal } from '@/panels/Terminal';
import { Output } from '@/panels/Output';
import { PanelMount } from '@/shell/motion/PanelMount';

export type PanelKey = 'explorer' | 'editor' | 'terminal' | 'output';

// dockview 通过 component 名字 → React FC 映射;PanelMount 包一层进出场动画。
export const panelComponents: Record<PanelKey, React.FC<IDockviewPanelProps>> = {
  explorer: (p) => (
    <PanelMount panelId={p.api.id}>
      <Explorer />
    </PanelMount>
  ),
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
