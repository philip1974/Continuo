import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type SerializedDockview,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { coApp } from '@/plugins/co-app';
import { PanelMount } from '@/shell/motion/PanelMount';
import { applyDefaultLayout } from './layout.default';
import { HeaderActions } from './HeaderActions';
import { EmptyState } from './EmptyState';
import { setDockApi } from './dock-api-ref';
import { wrapPanelClose } from './wrap-panel-close';
import { SharedTab } from '@/shell/motion/SharedTab';
import { useClosingStore } from '@/stores/closing.store';
import { useEditorStore } from '@/stores/editor.store';
import { debounce } from '@/lib/debounce';
import { coApi } from '@/lib/co-api';
import { TAB_DRAG_MIME, decodeTabDragPayload, type TabDragPayload } from '@/lib/tab-drag-payload';
import { isPopoutWindow } from '@/lib/popout-mode';
import { getPaneController } from '@/panels/Terminal/PaneControllerRegistry';
import '@/styles/dockview.css';

// 外提到 module 顶层常量:DockviewReact 的 components/tabComponents 引用稳定
// 才能避免 dockview 内部 effect 误判 props 变化。每次 render 新建对象会
// 触发 dockview 重订阅 createComponent。同 panelComponents 对照(useMemo)。
const tabComponents = { default: SharedTab };

// topic-05: dockview Position('top'/'bottom'/'left'/'right'/'center') → addPanel
// position.direction('above'/'below'/'left'/'right'/'within')。
// center 不映射(我们的 drop 不应落 center — 那意味着合并 tab 到现有 group,
// 等价 V1 不支持的反向 promote;简化为 right)。
function positionToAddDirection(
  position: 'top' | 'bottom' | 'left' | 'right' | 'center',
): 'above' | 'below' | 'left' | 'right' | 'within' {
  switch (position) {
    case 'top':
      return 'above';
    case 'bottom':
      return 'below';
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'center':
      return 'within';
  }
}

async function handleExternalTabDrop(
  payload: TabDragPayload,
  position: 'top' | 'bottom' | 'left' | 'right' | 'center',
  group: unknown,
  api: DockviewApi,
): Promise<void> {
  const currentWindowId = coApi.system.windowId;
  const controller = getPaneController(currentWindowId, payload.sourcePanelId);
  if (!controller) {
    console.warn('[tab-drag] DROP_EXTERNAL no source controller for panel=', payload.sourcePanelId);
    return;
  }
  const result = controller.detachTab(payload.sourceTabId, { forMove: true });
  if (!result.detached) {
    console.warn('[tab-drag] DROP_EXTERNAL detach rejected reason=', result.reason);
    return;
  }
  // 让 React 先 commit 完 unmount 原 TerminalLeaf,避免双 useTerminal mount 双订阅 PTY。
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const direction = positionToAddDirection(position);
  console.debug('[tab-drag] DROP_EXTERNAL position=', position, 'direction=', direction, 'sessionId=', payload.sessionId);
  try {
    api.addPanel({
      id: `terminal-${payload.sessionId}`,
      component: 'terminal',
      title: payload.title,
      ...(direction !== 'within'
        ? {
            position: {
              referenceGroup: group as never,
              direction,
            },
          }
        : {}),
      params: {
        sessionId: payload.sessionId,
        cwd: result.leafSnapshot.cwd ?? undefined,
        title: payload.title,
        role: 'promoted',
      },
    });
  } catch (err) {
    console.error('[tab-drag] DROP_EXTERNAL addPanel failed', err);
    // V1: addPanel 失败时不回滚 detach(已经从 reducer 移除);agent 看到 NOT_FOUND 自查
    return;
  }
  // 原 panel 空了就主动关
  controller.closeIfStillEmpty();
}

interface FlushBridge {
  readonly layout?: {
    readonly onFlushRequest?: (cb: () => Promise<void>) => () => void;
    readonly sendFlushAck?: (windowId: number) => void;
  };
  readonly system?: {
    readonly windowId?: number;
  };
}

function getFlushBridge(): FlushBridge | undefined {
  return (window as Window & { electron?: FlushBridge }).electron;
}

export function sanitizePersistedDockLayout(json: unknown): unknown {
  if (!json || typeof json !== 'object') return json;
  const j = json as {
    panels?: Record<string, { contentComponent?: string; params?: unknown }>;
  };
  if (!j.panels || typeof j.panels !== 'object') return j;
  for (const panelId of Object.keys(j.panels)) {
    const panel = j.panels[panelId];
    if (
      panel?.contentComponent === 'terminal' &&
      panel.params &&
      typeof panel.params === 'object'
    ) {
      panel.params = sanitizeTerminalPanelParams(
        panel.params as Record<string, unknown>,
      );
    }
  }
  return j;
}

function sanitizeTerminalPanelParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const { sessionId: _sessionId, ...rest } = params;
  const tabsState = rest.tabsState;
  if (
    tabsState !== undefined &&
    (!tabsState ||
      typeof tabsState !== 'object' ||
      !Array.isArray((tabsState as { tabs?: unknown }).tabs))
  ) {
    const { tabsState: _tabsState, ...withoutBadTabsState } = rest;
    return withoutBadTabsState;
  }
  return rest;
}

/** 把 coApp.panels 注册的 PanelSpec 桥接成 Dockview 的 components map.
 *  每个 panel 自动包 PanelMount(进出场动画). */
function usePanelComponents(): Record<string, React.FC<IDockviewPanelProps>> {
  const [snapshot, setSnapshot] = useState(() => coApp.panels.getAll());
  useEffect(
    () => coApp.panels.subscribe(() => setSnapshot(coApp.panels.getAll())),
    [],
  );
  return useMemo(() => {
    const map: Record<string, React.FC<IDockviewPanelProps>> = {};
    for (const spec of snapshot) {
      const Factory = spec.factory;
      map[spec.type] = (p) => (
        <PanelMount panelId={p.api.id}>
          {Factory(p) as React.ReactNode}
        </PanelMount>
      );
    }
    return map;
  }, [snapshot]);
}

export function DockShell({ onLayoutReady }: { onLayoutReady?: () => void }) {
  const apiRef = useRef<DockviewApi | null>(null);
  // apiReady 是 state(不是 ref):驱动下面 editor 自动激活 useEffect 的依赖,
  // 修复"hydrate 在 onReady 之前完成 → activeTabId 变化触发 effect 时
  // apiRef.current 仍 null → 错过添加 panel"的时序竞态。
  const [apiReady, setApiReady] = useState(false);
  const [empty, setEmpty] = useState(false);
  const panelComponents = usePanelComponents();

  const onReady = useCallback(
    async (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      setApiReady(true);
      setDockApi(event.api); // 暴露给 IconSidebar 等 Dockview 之外的组件
      const readResult = await coApi.layout.read();
      const persisted = readResult.ok ? readResult.data : null;
      if (!readResult.ok) {
        console.warn('[dock] layout:read failed', readResult.code, readResult.message);
      }

      let restored = false;
      if (persisted && typeof persisted === 'object') {
        try {
          event.api.fromJSON(
            sanitizePersistedDockLayout(persisted) as SerializedDockview,
          );
          restored = true;
        } catch (err) {
          console.warn('[dock] fromJSON 失败,落回默认布局', err);
        }
      }
      if (!restored) applyDefaultLayout(event.api);

      // Explorer 已迁出 Dockview → 固定左 sidebar(VSCode 风)。
      // 旧 layout.json 可能仍含 'explorer' panel(已无对应 component),清理掉。
      const orphanExplorer = event.api.getPanel('explorer');
      if (orphanExplorer) {
        try {
          orphanExplorer.api.close();
        } catch {
          /* ignore */
        }
      }

      setEmpty(event.api.totalPanels === 0);
      onLayoutReady?.();

      const persist = debounce(async () => {
        const snapshot = event.api.toJSON() as unknown;
        const payload = { version: 1 as const, ...(snapshot as object) };
        const r = await coApi.layout.write(payload);
        if (!r.ok) console.warn('[dock] layout:write failed', r.code, r.message);
      }, 300);

      event.api.onDidLayoutChange(() => {
        persist();
        setEmpty(event.api.totalPanels === 0);
      });

      // 防 closing-store 残留:panel 真被 removed 后从 set 摘掉,
      // 避免后续同 id panel 一上来就走 EXIT 动画。
      event.api.onDidRemovePanel((panel) => {
        useClosingStore.getState().unmark(panel.id);
      });

      // 拦截所有 panel 的 api.close,统一走"标记 closing → 220ms 延迟 → 真 close"。
      // 包括 group 整体关闭、第三方调用方等间接路径,只要走 api.close 都能拿到动画。
      event.api.panels.forEach(wrapPanelClose);
      event.api.onDidAddPanel(wrapPanelClose);

      // topic-05: 外部 tab 拖入 dockview 区时显示 overlay + 处理 drop。
      // onUnhandledDragOverEvent 在 dataTransfer 不是 dockview 自己 PanelTransfer 时
      // 触发(我们的 MIME = application/x-continuo-terminal-tab),accept() 让 dockview
      // 走完整 drop overlay 流程。
      //
      // 关键:只在 target === 'edge' 时 accept,让 panel 内部(content / center / tab)
      // 的 drag 事件 bubble 到内部 TerminalPaneTree.onDragOver/onDrop 触发 BSP
      // attach。否则 dockview 会接管整个 panel 当 drop target,内部 handler 收不到事件。
      event.api.onUnhandledDragOverEvent((evt) => {
        const types = evt.nativeEvent.dataTransfer?.types ?? [];
        if (!Array.from(types).includes(TAB_DRAG_MIME)) return;
        if (evt.target === 'edge') {
          evt.accept();
        }
        // target ∈ {tab, header_space, content} → 不 accept,事件 bubble 给内部
      });
      event.api.onDidDrop((evt) => {
        if (isPopoutWindow()) return;
        const payload = decodeTabDragPayload(evt.nativeEvent.dataTransfer);
        if (!payload) return;
        const currentWindowId = coApi.system.windowId;
        if (payload.windowId !== currentWindowId) {
          console.debug('[tab-drag] CROSS_WINDOW_REJECTED payload.windowId=', payload.windowId);
          return;
        }
        void handleExternalTabDrop(payload, evt.position, evt.group, event.api);
      });
    },
    [onLayoutReady],
  );

  const restore = useCallback(() => {
    if (apiRef.current) applyDefaultLayout(apiRef.current);
  }, []);

  // unmount 时 reset 单例,防 stale 引用
  useEffect(() => () => setDockApi(null), []);

  useEffect(() => {
    if (!apiReady) return;
    const api = apiRef.current;
    if (!api) return;
    const bridge = getFlushBridge();
    const off = bridge?.layout?.onFlushRequest?.(async () => {
      try {
        await coApi.layout.write(api.toJSON());
      } finally {
        const latest = getFlushBridge();
        latest?.layout?.sendFlushAck?.(latest.system?.windowId ?? 0);
      }
    });
    return () => {
      off?.();
    };
  }, [apiReady]);

  // Editor 自动激活:Explorer 单击文件 / hydrate 恢复 session → editor.store
  // activeTabId 变 → 自动 setActive 'editor' panel(VSCode 行为)。
  // 若 panel 不存在(用户拖关了 / 启动时 layout 没含),自动 addPanel 加回。
  //
  // deps 必含 apiReady:让 onReady 完成晚于 activeTabId hydrate 的场景也能补建。
  // deps 必含 editorFocusPulse:同 id 重新点击(activeTabId 不变)也要触发,
  // 否则用户切到 terminal 后再点资源管理器同一文档,terminal 不会让位。见 #22。
  const editorActiveTabId = useEditorStore((s) => s.activeTabId);
  const editorFocusPulse = useEditorStore((s) => s.editorFocusPulse);
  useEffect(() => {
    if (!editorActiveTabId) return;
    if (!apiReady) return;
    const api = apiRef.current;
    if (!api) return;
    let editorPanel = api.getPanel('editor');
    if (!editorPanel) {
      editorPanel = api.addPanel({
        id: 'editor',
        component: 'editor',
        title: 'Editor',
      });
    }
    editorPanel.api.setActive();
  }, [editorActiveTabId, editorFocusPulse, apiReady]);

  return (
    <div className="relative h-full w-full">
      <DockviewReact
        components={panelComponents}
        tabComponents={tabComponents}
        defaultTabComponent={SharedTab}
        rightHeaderActionsComponent={HeaderActions}
        onReady={onReady}
        className="dockview-theme-abyss h-full w-full"
      />
      {empty && <EmptyState onRestore={restore} />}
    </div>
  );
}
