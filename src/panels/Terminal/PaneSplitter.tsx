import type { ReactNode } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import type { PanelAction } from './panelReducer';
import type { SplitDirection } from './paneTree';

interface PaneSplitterProps {
  tabId: string;
  splitId: string;
  direction: SplitDirection;
  ratio: number;
  dispatch: (action: PanelAction) => void;
  a: ReactNode;
  b: ReactNode;
}

export function PaneSplitter({
  tabId,
  splitId,
  direction,
  ratio,
  dispatch,
  a,
  b,
}: PaneSplitterProps) {
  const firstSize = clampRatio(ratio);
  const secondSize = 100 - firstSize;
  return (
    <PanelGroup
      direction={direction}
      className="h-full w-full"
      onLayout={(sizes) => {
        const next = sizes[0];
        if (typeof next !== 'number') return;
        dispatch({
          type: 'PANE_ACTION',
          tabId,
          action: { type: 'RESIZE', splitId, ratio: next },
        });
      }}
    >
      <Panel minSize={10} defaultSize={firstSize} className="min-h-0 min-w-0">
        {a}
      </Panel>
      <PanelResizeHandle
        className={[
          'shrink-0 bg-line/80 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
          direction === 'horizontal' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
        ].join(' ')}
        aria-label="Resize terminal panes"
      />
      <Panel minSize={10} defaultSize={secondSize} className="min-h-0 min-w-0">
        {b}
      </Panel>
    </PanelGroup>
  );
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 50;
  return Math.min(90, Math.max(10, ratio));
}
