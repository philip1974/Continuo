import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type SerializedDockview,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { panelComponents } from './panels';
import { applyDefaultLayout } from './layout.default';
import { HeaderActions } from './HeaderActions';
import { EmptyState } from './EmptyState';
import { setDockApi } from './dock-api-ref';
import { wrapPanelClose } from './wrap-panel-close';
import { SharedTab } from '@/shell/motion/SharedTab';
import { useClosingStore } from '@/stores/closing.store';
import { useEditorStore } from '@/stores/editor.store';
import { debounce } from '@/lib/debounce';
import '@/styles/dockview.css';

const tabComponents = { default: SharedTab };

export function DockShell({ onLayoutReady }: { onLayoutReady?: () => void }) {
  const apiRef = useRef<DockviewApi | null>(null);
  const [empty, setEmpty] = useState(false);

  const onReady = useCallback(
    async (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      setDockApi(event.api); // 暴露给 IconSidebar 等 Dockview 之外的组件
      const readResult = await window.api.layout.read();
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
      setEmpty(event.api.totalPanels === 0);
      onLayoutReady?.();

      const persist = debounce(async () => {
        const snapshot = event.api.toJSON() as unknown;
        const payload = { version: 1 as const, ...(snapshot as object) };
        const r = await window.api.layout.write(payload);
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
  // 若 panel 不存在(用户拖关了),自动 addPanel 重新加回到 explorer 右侧。
  const editorActiveTabId = useEditorStore((s) => s.activeTabId);
  useEffect(() => {
    if (!editorActiveTabId) return;
    const api = apiRef.current;
    if (!api) return;
    let editorPanel = api.getPanel('editor');
    if (!editorPanel) {
      const explorer = api.getPanel('explorer');
      editorPanel = api.addPanel({
        id: 'editor',
        component: 'editor',
        title: 'Editor',
        position: explorer
          ? { referencePanel: explorer.id, direction: 'right' }
          : undefined,
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
