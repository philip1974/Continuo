import type { DragEvent } from 'react';
import type { PanelAction } from './panelReducer';
import type { PaneNode, SplitDirection } from './paneTree';
import { PaneSplitter } from './PaneSplitter';
import { TerminalLeaf } from './TerminalLeaf';
import { TAB_DRAG_MIME, decodeTabDragPayload } from '@/lib/tab-drag-payload';
import { getPaneController } from './PaneControllerRegistry';
import { coApi } from '@/lib/co-api';

interface TerminalPaneTreeProps {
  panelId: string;
  tabId: string;
  tree: PaneNode;
  activeLeafId?: string;
  visible: boolean;
  dispatch: (action: PanelAction) => void;
}

/**
 * topic-05: drop 到本 panel 内部 pane 区时,根据 pointer 落点 + leaf bbox 决定
 * direction + target leaf。
 * - hit target 必须是带 [data-pane-leaf-id] 的元素(找最近祖先)
 * - 落点相对 bbox 四象限 → direction
 *   左半-上半 → above? 简化:垂直划分 → above/below;水平划分 → left/right
 *   策略:看 bbox 哪边距 pointer 最远(留更多空间给 incoming leaf)→ 决定 direction
 * - 落 splitter handle / gap / padding(找不到 leaf 元素)→ return null fallback(P1-4)
 */
function resolveInternalDropTarget(
  event: DragEvent<HTMLDivElement>,
): { leafId: string; dir: SplitDirection } | null {
  const target = event.target as HTMLElement | null;
  if (!target) return null;
  const leafEl = target.closest('[data-pane-leaf-id]') as HTMLElement | null;
  if (!leafEl) return null;
  const leafId = leafEl.dataset.paneLeafId;
  if (!leafId) return null;
  const rect = leafEl.getBoundingClientRect();
  const relX = (event.clientX - rect.left) / rect.width;
  const relY = (event.clientY - rect.top) / rect.height;
  // 四象限到 direction:象限离 leaf 中心的角度对应 left/right/horizontal 还是
  // top/bottom/vertical。简化:看 relX 离中心远还是 relY 离中心远。
  const dx = Math.abs(relX - 0.5);
  const dy = Math.abs(relY - 0.5);
  let dir: SplitDirection;
  if (dx > dy) {
    dir = 'horizontal'; // 左右分屏
  } else {
    dir = 'vertical'; // 上下分屏
  }
  return { leafId, dir };
}

export function TerminalPaneTree({
  panelId,
  tabId,
  tree,
  activeLeafId,
  visible,
  dispatch,
}: TerminalPaneTreeProps) {
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer.types).includes(TAB_DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // 暴露给 devtools console 检查;不刷屏 — 只 active tab 看到
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    console.debug('[tab-drag] PANE_DROP fired tabId=', tabId, 'types=', Array.from(e.dataTransfer.types));
    const payload = decodeTabDragPayload(e.dataTransfer);
    if (!payload) {
      console.debug('[tab-drag] PANE_DROP decode failed payload=null');
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const windowId = coApi.system.windowId;
    if (payload.windowId !== windowId) {
      console.debug('[tab-drag] CROSS_WINDOW_REJECTED payload.windowId=', payload.windowId);
      return;
    }
    // 防自捅自:同 panelId + 同 tabId 拖回自己 pane 区,无意义
    if (payload.sourcePanelId === panelId && payload.sourceTabId === tabId) {
      console.debug('[tab-drag] DROP_INTERNAL self-drop ignored');
      return;
    }
    const hit = resolveInternalDropTarget(e);
    if (!hit) {
      console.debug('[tab-drag] DROP_HIT_TEST_FAIL target=splitter-or-gap');
      return; // P1-4: 不 detach
    }
    const sourceController = getPaneController(windowId, payload.sourcePanelId);
    if (!sourceController) return;
    const detached = sourceController.detachTab(payload.sourceTabId, { forMove: true });
    if (!detached.detached) {
      console.debug('[tab-drag] DROP_INTERNAL detach rejected reason=', detached.reason);
      return;
    }
    requestAnimationFrame(() => {
      console.debug(
        '[tab-drag] DROP_INTERNAL targetLeaf=',
        hit.leafId,
        'dir=',
        hit.dir,
        'sessionId=',
        payload.sessionId,
      );
      dispatch({
        type: 'PANE_ACTION',
        tabId,
        action: {
          type: 'ATTACH_LEAF_FROM_DETACHED',
          targetLeafId: hit.leafId,
          dir: hit.dir,
          leaf: detached.leafSnapshot,
        },
      });
      sourceController.closeIfStillEmpty();
    });
  };
  return (
    <div
      className="absolute inset-0 min-h-0 min-w-0"
      style={{
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
      }}
      data-terminal-tab-id={tabId}
      onDragOver={onDragOver}
      onDrop={onDrop}
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
