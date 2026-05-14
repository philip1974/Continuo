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
import '@/styles/dockview.css';

// 外提到 module 顶层常量:DockviewReact 的 components/tabComponents 引用稳定
// 才能避免 dockview 内部 effect 误判 props 变化。每次 render 新建对象会
// 触发 dockview 重订阅 createComponent。同 panelComponents 对照(useMemo)。
const tabComponents = { default: SharedTab };

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
