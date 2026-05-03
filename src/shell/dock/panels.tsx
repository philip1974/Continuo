import type { IDockviewPanelProps } from 'dockview-react';
import { Explorer } from '@/panels/Explorer';
import { Editor } from '@/panels/Editor';
import { Terminal } from '@/panels/Terminal';
import { Output } from '@/panels/Output';
import { PanelMount } from '@/shell/motion/PanelMount';

export type PanelKey = 'explorer' | 'editor' | 'terminal' | 'output';

// dockview 通过 component 名字 → React FC 映射;PanelMount 包一层进场动画。
export const panelComponents: Record<PanelKey, React.FC<IDockviewPanelProps>> = {
  explorer: () => (
    <PanelMount>
      <Explorer />
    </PanelMount>
  ),
  editor: () => (
    <PanelMount>
      <Editor />
    </PanelMount>
  ),
  terminal: () => (
    <PanelMount>
      <Terminal />
    </PanelMount>
  ),
  output: () => (
    <PanelMount>
      <Output />
    </PanelMount>
  ),
};
