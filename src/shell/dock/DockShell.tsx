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
  const [empty, setEmpty] = useState(false);
  const panelComponents = usePanelComponents();

  const onReady = useCallback(
    async (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      setDockApi(event.api); // 暴露给 IconSidebar 等 Dockview 之外的组件
      const readResult = await coApi.layout.read();
      const persisted = readResult.ok ? readResult.data : null;
      if (!readResult.ok) {
        console.warn('[dock] layout:read failed', readResult.code, readResult.message);
      }

      let restored = false;
      if (persisted && typeof persisted === 'object') {
        try {
          event.api.fromJSON(persisted as SerializedDockview);
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

  // Editor 自动激活:Explorer 单击文件 → editor.store activeTabId 变 →
  // 自动 setActive 'editor' panel(VSCode 行为)。
  // 若 panel 不存在(用户拖关了),自动 addPanel 加回(无 reference 即默认主区)。
  const editorActiveTabId = useEditorStore((s) => s.activeTabId);
  useEffect(() => {
    if (!editorActiveTabId) return;
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
  }, [editorActiveTabId]);

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
