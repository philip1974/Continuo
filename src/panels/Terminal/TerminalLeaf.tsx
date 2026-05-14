import { IconButton, Spinner } from '@/design';
import type { LeafNode } from './paneTree';
import type { PanelAction } from './panelReducer';
import { useTerminal } from './useTerminal';

interface TerminalLeafProps {
  panelId: string;
  tabId: string;
  leaf: LeafNode;
  active: boolean;
  dispatch: (action: PanelAction) => void;
}

export function TerminalLeaf({
  panelId,
  tabId,
  leaf,
  active,
  dispatch,
}: TerminalLeafProps) {
  const closeLeaf = () => {
    dispatch({
      type: 'PANE_ACTION',
      tabId,
      action: { type: 'CLOSE_LEAF_BEGIN', leafId: leaf.id },
    });
    window.setTimeout(() => {
      dispatch({
        type: 'PANE_ACTION',
        tabId,
        action: { type: 'CLOSE_LEAF_COMMIT', leafId: leaf.id },
      });
    }, 120);
  };

  return (
    <div
      className={[
        'group/leaf relative h-full w-full min-w-0 overflow-hidden bg-canvas',
        active ? 'ring-1 ring-inset ring-accent' : 'ring-1 ring-inset ring-transparent',
        leaf.closing ? 'opacity-60' : '',
      ].join(' ')}
      data-pane-leaf-id={leaf.id}
      data-active={active ? 'true' : 'false'}
      onPointerDown={() =>
        dispatch({
          type: 'PANE_ACTION',
          tabId,
          action: { type: 'FOCUS_LEAF', leafId: leaf.id },
        })
      }
    >
      <IconButton
        size="sm"
        aria-label="Close terminal pane"
        title="关闭终端分屏"
        onClick={closeLeaf}
        className="absolute right-1 top-1 z-10 opacity-0 transition-opacity group-hover/leaf:opacity-100 focus-visible:opacity-100"
      >
        ×
      </IconButton>
      {leaf.ptyId ? (
        <PtyTerminal
          termId={leaf.ptyId}
          panelId={panelId}
          tabId={tabId}
          leafId={leaf.id}
        />
      ) : leaf.spawnFailed ? (
        <div
          className="flex h-full w-full items-center justify-center text-xs text-danger"
          aria-label="Terminal pane spawn failed"
        >
          启动失败
        </div>
      ) : (
        <div
          className="flex h-full w-full items-center justify-center gap-2 text-xs text-fg-dim"
          aria-label="Terminal pane spawning"
        >
          <Spinner size="sm" />
          <span>启动中...</span>
        </div>
      )}
    </div>
  );
}

function PtyTerminal({
  termId,
  panelId,
  tabId,
  leafId,
}: {
  termId: string;
  panelId: string;
  tabId: string;
  leafId: string;
}) {
  const { containerRef, isReady } = useTerminal(termId, {
    panelId,
    tabId,
    leafId,
  });
  return (
    <div className="relative h-full w-full">
      <div className="h-full w-full bg-canvas px-2 py-1">
        <div
          ref={containerRef}
          data-testid="terminal-pane-leaf-xterm-host"
          className="h-full w-full overflow-x-hidden"
          style={{ minHeight: 0 }}
        />
      </div>
      {!isReady && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas/70 backdrop-blur-[2px]"
          aria-label="Terminal pane shell starting"
        >
          <div className="flex items-center gap-2 text-xs text-fg-dim">
            <Spinner size="sm" />
            <span>启动 shell...</span>
          </div>
        </div>
      )}
    </div>
  );
}
