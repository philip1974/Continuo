import type { PanelAction } from './panelReducer';
import type { PaneNode } from './paneTree';
import { PaneSplitter } from './PaneSplitter';
import { TerminalLeaf } from './TerminalLeaf';

interface TerminalPaneTreeProps {
  panelId: string;
  tabId: string;
  tree: PaneNode;
  activeLeafId?: string;
  visible: boolean;
  dispatch: (action: PanelAction) => void;
}

export function TerminalPaneTree({
  panelId,
  tabId,
  tree,
  activeLeafId,
  visible,
  dispatch,
}: TerminalPaneTreeProps) {
  return (
    <div
      className="absolute inset-0 min-h-0 min-w-0"
      style={{
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
      }}
      data-terminal-tab-id={tabId}
    >
      {renderNode({ panelId, tabId, node: tree, activeLeafId, dispatch })}
    </div>
  );
}

function renderNode({
  panelId,
  tabId,
  node,
  activeLeafId,
  dispatch,
}: {
  panelId: string;
  tabId: string;
  node: PaneNode;
  activeLeafId?: string;
  dispatch: (action: PanelAction) => void;
}) {
  if (node.kind === 'leaf') {
    return (
      <TerminalLeaf
        panelId={panelId}
        tabId={tabId}
        leaf={node}
        active={node.id === activeLeafId}
        dispatch={dispatch}
      />
    );
  }

  return (
    <PaneSplitter
      tabId={tabId}
      splitId={node.id}
      direction={node.dir}
      ratio={node.ratio}
      dispatch={dispatch}
      a={renderNode({ panelId, tabId, node: node.a, activeLeafId, dispatch })}
      b={renderNode({ panelId, tabId, node: node.b, activeLeafId, dispatch })}
    />
  );
}
