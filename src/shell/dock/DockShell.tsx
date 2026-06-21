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
import { useRegistry } from '@/plugins/registries/useRegistry';
import { PanelMount } from '@/shell/motion/PanelMount';
import { applyDefaultLayout } from './layout.default';
import { HeaderActions } from './HeaderActions';
import { EmptyState } from './EmptyState';
import { setDockApi } from './dock-api-ref';
import { focusTerminalPanel } from '@/panels/Terminal/terminal-focus-registry';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { useDockReconciler } from './DockReconciler';
import { useDockLocaleSync } from './useDockLocaleSync';
import { wrapPanelClose, cancelPendingPanelClose } from './wrap-panel-close';
import { handleTerminalPanelRemoved } from './DockReconciler';
import { SharedTab } from '@/shell/motion/SharedTab';
import { useClosingStore } from '@/stores/closing.store';
import { useEditorStore } from '@/stores/editor.store';
import { debounce } from '@/lib/debounce';
import { flushExplorerPersistence } from '@/lib/persist/explorer-persist';
import { flushPendingAutoSave } from '@/panels/Editor/autosave-flush-registry';
import { coApi } from '@/lib/co-api';
import '@/styles/dockview.css';

// 外提到 module 顶层常量:DockviewReact 的 components/tabComponents 引用稳定
// 才能避免 dockview 内部 effect 误判 props 变化。每次 render 新建对象会
// 触发 dockview 重订阅 createComponent。同 panelComponents 对照(useMemo)。
const tabComponents = { default: SharedTab };

interface FlushBridge {
  readonly layout?: {
    readonly onFlushRequest?: (
      cb: (payload?: { windowId: number }) => Promise<void>,
    ) => () => void;
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
    panels?: Record<string, { contentComponent?: string }>;
  };
  if (!j.panels || typeof j.panels !== 'object') return j;
  for (const panelId of Object.keys(j.panels)) {
    const panel = j.panels[panelId];
    if (panel?.contentComponent === TERMINAL_PANEL_TYPE) {
      return null;
    }
  }
  return j;
}

/** 把 coApp.panels 注册的 PanelSpec 桥接成 Dockview 的 components map.
 *  每个 panel 自动包 PanelMount(进出场动画). */
function usePanelComponents(): Record<string, React.FC<IDockviewPanelProps>> {
  const snapshot = useRegistry(coApp.panels);
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

function DockReconcilerMount({ api }: { api: DockviewApi }): null {
  useDockReconciler(api);
  useDockLocaleSync(api);
  return null;
}

// 可维护性 M10:dock layout 写盘单一来源(toJSON → {version:1,...} payload → layout.write
// → r.ok 失败 warn)。自动持久化(onDidLayoutChange debounce)与关窗 flush 共用,避免
// payload 结构 / 版本号 / 错误处理在两处漂移。warnPrefix 区分日志来源;调用方各自决定是否
// 再包 try/catch(flush 路径需捕获 toJSON/write 异常,debounce 路径沿用原行为不捕获)。
async function writeDockLayoutSnapshot(
  api: DockviewApi,
  warnPrefix: string,
): Promise<void> {
  const snapshot = api.toJSON() as unknown;
  const r = await coApi.layout.write({
    version: 1 as const,
    ...(snapshot as object),
  });
  if (!r.ok) console.warn(`${warnPrefix} failed`, r.code, r.message);
}

export function DockShell({ onLayoutReady }: { onLayoutReady?: () => void }) {
  const apiRef = useRef<DockviewApi | null>(null);
  const [dockApi, setReconcilerApi] = useState<DockviewApi | null>(null);
  // apiReady 是 state(不是 ref):驱动下面 editor 自动激活 useEffect 的依赖,
  // 修复"hydrate 在 onReady 之前完成 → activeTabId 变化触发 effect 时
  // apiRef.current 仍 null → 错过添加 panel"的时序竞态。
  const [apiReady, setApiReady] = useState(false);
  const [empty, setEmpty] = useState(false);
  const panelComponents = usePanelComponents();

  const onReady = useCallback(
    async (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      setReconcilerApi(event.api);
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
          const sanitized = sanitizePersistedDockLayout(persisted);
          if (sanitized === null) {
            throw new Error('persisted layout contains terminal panels');
          }
          event.api.fromJSON(sanitized as SerializedDockview);
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

      const persist = debounce(
        () => writeDockLayoutSnapshot(event.api, '[dock] layout:write'),
        300,
      );

      event.api.onDidLayoutChange(() => {
        persist();
        setEmpty(event.api.totalPanels === 0);
      });

      // 防 closing-store 残留:panel 真被 removed 后从 set 摘掉,
      // 避免后续同 id panel 一上来就走 EXIT 动画。
      // terminal panel:同时走 handleTerminalPanelRemoved 反向通知 main
      // remove session(suppress flag + move-vs-real-close 区分由 helper 管)。
      event.api.onDidRemovePanel((panel) => {
        useClosingStore.getState().unmark(panel.id);
        void handleTerminalPanelRemoved({
          panel,
          api: event.api,
          removeSession: (sid) => coApi.terminal.remove(sid).then(() => undefined),
        });
      });

      // 拦截所有 panel 的 api.close,统一走"标记 closing → 220ms 延迟 → 真 close"。
      // 包括 group 整体关闭、第三方调用方等间接路径,只要走 api.close 都能拿到动画。
      event.api.panels.forEach(wrapPanelClose);
      event.api.onDidAddPanel(wrapPanelClose);

      // topic-22: exit-maximize 后把 focus 拉回 xterm。
      // setActive() 不会触发 onDidActiveChange(panel 在 exit 前已是 active),
      // 所以必须显式调 focusTerminalPanel。用 event.group.activePanel
      // (codex red-team v1 P1-3) 不重读全局 activePanel,避免 exit 期间被改写。
      event.api.onDidMaximizedGroupChange((evt) => {
        if (evt.isMaximized) return;
        const panel = evt.group.activePanel;
        if (!panel) return;
        if (panel.view.contentComponent !== TERMINAL_PANEL_TYPE) return;
        focusTerminalPanel(panel.id);
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
    const off = bridge?.layout?.onFlushRequest?.(async (payload) => {
      try {
        await writeDockLayoutSnapshot(api, '[dockview] flush save');
      } catch (err) {
        console.warn('[dockview] flush save failed', err);
      }
      // 除 dockview layout 外,explorer/editor 段(workspace 切换、打开的 tab、
      // 树展开)走的是独立的 300ms debounce 链,关窗前必须一并同步落盘,
      // 否则 ack 返回但这些改动随未触发的 timer 丢失。见审计 #4。
      try {
        await flushExplorerPersistence();
      } catch (err) {
        console.warn('[dockview] explorer flush failed', err);
      }
      // pending 的 markdown autosave 内容卡在 useAutoSave 的 2s 防抖 timer 里,
      // 只在 React unmount cleanup 才 flush,而 win.close() 销毁 renderer 时
      // React cleanup 不保证执行 → 编辑 md 后 2s 内关窗会丢最后一段。关窗前
      // 在 ack 之前同步落盘(P1-AE)。
      try {
        await flushPendingAutoSave();
      } catch (err) {
        console.warn('[dockview] autosave flush failed', err);
      }
      const latest = getFlushBridge();
      latest?.layout?.sendFlushAck?.(
        payload?.windowId ?? latest.system?.windowId ?? 0,
      );
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
        params: { titleKey: 'panels.editor.title' },
      });
    } else {
      // panel 仍存在但可能正处于关闭 EXIT 动画窗口内(用户刚关 editor 面板随即
      // 又点开文件)。撤销它排定中的真 close + 清 closing 标记,否则刚激活的
      // 面板会在 EXIT_DURATION_MS 后随排定的 close 一起消失(刚打开的文件没了)。
      cancelPendingPanelClose('editor');
    }
    editorPanel.api.setActive();
  }, [editorActiveTabId, editorFocusPulse, apiReady]);

  return (
    <div className="relative h-full w-full">
      {dockApi && <DockReconcilerMount api={dockApi} />}
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
