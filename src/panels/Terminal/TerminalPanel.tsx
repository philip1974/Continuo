// Terminal 主容器(M-Terminal Step T5 + Agent Terminal MCP P1)。
// 顶部 TerminalTabs(切换/新建/关闭)+ 主体多个 TerminalView(display:none/flex 切换,
// 不销毁 xterm 实例,scrollback 与滚动位置保留)。
//
// P1 改动:sessions 真相源搬到 main。本组件:
//   1. mount 调 listSessions 拉初始 snapshot
//   2. 订阅 onSessionsChanged 持续接收 snapshot → store.replaceSnapshot
//   3. handleNew → coApi.terminal.create + setActive 新 id
//   4. handleClose → coApi.terminal.remove(等价 kill + 删 metadata)
//   5. snapshot 仍空时自动 spawn 一个(用 module-level flag 防 StrictMode 双 spawn)

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import {
  useTerminalStore,
  type TerminalSession,
} from '@/stores/terminal.store';
import { TerminalTabs } from './TerminalTabs';
import { TerminalView } from './TerminalView';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { Button } from '@/design';
import { coApi } from '@/lib/co-api';
import { useTheme } from '@/theme';
import {
  createPaneController,
  registerPaneController,
  type PaneController,
} from './PaneControllerRegistry';
import {
  defaultPersistedState,
  panelReducer,
  serializeTabsStateForPersistence,
  type PanelEffect,
  type PanelState,
  type PersistedPanelState,
} from './panelReducer';
import {
  createSpawnQueue,
  removePtyOnce,
  setPanelDispatch,
  type SpawnQueue,
} from './spawnLeaf';
import { useDispatchWithEffects } from './useDispatchWithEffects';
import { TerminalPaneTree } from './TerminalPaneTree';

export type TerminalPanelParams = {
  sessionId?: string;
  cwd?: string;
  title?: string;
  role?: string;
  tabsState?: unknown;
};

// 让 P10k / oh-my-zsh 等 prompt 框架在 zsh 启动时检测到正确的终端亮度,
// 选 light/dark color set。X 标准 COLORFGBG = "<fg>;<bg>",bg ∈ {7,9..15}
// 视为 light。已在跑的 PTY 不会因主题切换而重渲 — 用户切主题后要关掉
// terminal 重开才能看到 prompt 配色跟着切。
function themedTerminalEnv(resolved: 'light' | 'dark'): Record<string, string> {
  return { COLORFGBG: resolved === 'dark' ? '15;0' : '0;15' };
}

// 模块级单例标志(跨 React mount/unmount 持久;App 真重启 / Cmd+R reload renderer
// 时 module 重新加载自动复位)。
// 解决:React 19 StrictMode 双 mount + spawn 异步 → useEffect 跑 2 次都看到
// sessions=[] → 双 spawn 出 2 个 terminal 的 bug。
let __terminalAutoSpawned = false;

export function TerminalPanel(
  props?: IDockviewPanelProps<TerminalPanelParams>,
) {
  if (!props?.api) return <LegacyTerminalPanel />;
  if (props.params?.sessionId) return <ScopedTerminalPanel termId={props.params.sessionId} />;
  return <InternalTerminalPanel props={props} />;
}

function ScopedTerminalPanel({ termId }: { termId: string }) {
  return (
    <div className="terminal-panel scoped flex h-full w-full overflow-hidden bg-canvas">
      <TerminalView termId={termId} />
    </div>
  );
}

function InternalTerminalPanel({
  props,
}: {
  props: IDockviewPanelProps<TerminalPanelParams>;
}) {
  const initial = useMemo<PanelState>(
    () => ({ tabs: [], activeTabId: null, hydrated: false }),
    [],
  );
  const { state, stateRef, dispatch, effectQueueRef, effectTrigger } =
    useDispatchWithEffects(panelReducer, initial);
  const removedPtyIds = useRef(new Set<string>()).current;
  const panelId = props.api.id;
  // spawnQueue 现用 module-level pending + dispatch lookup (见 spawnLeaf.ts 注释)
  // — StrictMode 双 mount 时去重 + 派到 current dispatch,不被 cleanup 误 cancel
  const spawnQueue = useMemo(
    () => createSpawnQueue(dispatch, removedPtyIds, panelId),
    [dispatch, removedPtyIds, panelId],
  );
  const workspaceRoot = useWorkspaceStore((s) => s.root);
  const windowId = coApi.system.windowId;
  const controllerRef = useRef<PaneController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createPaneController({
      panelId,
      windowId,
      dispatch,
      stateRef,
      removedPtyIds,
    });
  }
  const controller = controllerRef.current;

  useEffect(
    () => registerPaneController(controller.windowId, controller.panelId, controller),
    [controller],
  );

  // 同步 current dispatch 到 module-level map (spawn 完成时 lookup 派 SET_PTY_ID)。
  // 不 cleanup — 让 StrictMode 双 mount 第 2 个覆盖第 1 个,真 close 走
  // wrap-panel-close → cancelPanelSpawns(panelId) 清理。
  useEffect(() => {
    setPanelDispatch(panelId, dispatch);
  }, [panelId, dispatch]);

  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const persisted =
      readPersistedPanelState(props.params?.tabsState) ??
      defaultPersistedState(props.params?.cwd ?? workspaceRoot ?? undefined);
    dispatch({ type: 'HYDRATE', persisted });
  }, [dispatch, props.params?.cwd, props.params?.tabsState, workspaceRoot]);

  useEffect(() => {
    if (effectQueueRef.current.length > 0) {
      console.debug('[pane-split] hydrate-effect-flush', effectQueueRef.current.length);
    }
    while (effectQueueRef.current.length > 0) {
      const effect = effectQueueRef.current.shift();
      if (effect) handlePanelEffect(effect, spawnQueue, removedPtyIds, props.api);
    }
  }, [effectTrigger, effectQueueRef, props.api, removedPtyIds, spawnQueue]);

  useEffect(() => {
    if (!state.hydrated) return;
    const timer = window.setTimeout(() => {
      props.api.updateParameters({
        tabsState: serializeTabsStateForPersistence(state),
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [props.api, state]);

  // 注:不在 useEffect cleanup 调 spawnQueue.cancelAll() — React 19 StrictMode
  // dev mode mount→unmount→remount 会误 cancel 第一次 mount 的 in-flight spawn。
  // 真 close 由 wrap-panel-close 触发 cancelPanelSpawns(panelId)。

  if (!state.hydrated) {
    return (
      <div className="terminal-panel hydrating flex h-full w-full items-center justify-center bg-canvas text-sm text-fg-muted">
        加载布局...
      </div>
    );
  }

  return (
    <div className="terminal-panel flex h-full w-full flex-col overflow-hidden bg-canvas">
      <TerminalTabs
        tabs={state.tabs.map((tab) => ({ id: tab.id, title: tab.title }))}
        activeId={state.activeTabId}
        onSelect={(tabId) => dispatch({ type: 'SELECT_TAB', tabId })}
        onNew={() => {
          const tabId = newId('tab');
          const leafId = newId('leaf');
          dispatch({
            type: 'ADD_TAB',
            tabId,
            primaryLeafId: leafId,
            title: 'Terminal',
            cwd: workspaceRoot ?? undefined,
          });
        }}
        onClose={(tabId) => dispatch({ type: 'CLOSE_TAB', tabId })}
      />
      <div className="relative min-h-0 flex-1">
        {state.tabs.map((tab) => (
          <TerminalPaneTree
            key={tab.id}
            panelId={controller.panelId}
            tabId={tab.id}
            tree={tab.paneTree}
            activeLeafId={tab.activeLeafId}
            visible={tab.id === state.activeTabId}
            dispatch={dispatch}
          />
        ))}
        {state.tabs.length === 0 && (
          <div className="flex h-full w-full items-center justify-center text-sm text-fg-muted">
            无活跃终端
          </div>
        )}
      </div>
    </div>
  );
}

function handlePanelEffect(
  effect: PanelEffect,
  queue: SpawnQueue,
  removedPtyIds: Set<string>,
  panelApi: IDockviewPanelProps<TerminalPanelParams>['api'],
): void {
  switch (effect.type) {
    case 'ENQUEUE_SPAWN':
      queue.enqueue({
        tabId: effect.tabId,
        leafId: effect.leafId,
        cwd: effect.cwd,
        scoped: effect.scoped,
        reason: effect.reason,
        cancelled: { current: false },
      });
      break;
    case 'LEAF_CLOSED':
      queue.cancelLeaf(effect.tabId, effect.leafId);
      removePtyOnce(effect.ptyId, removedPtyIds, coApi.terminal.remove, 'leaf-close');
      break;
    case 'TAB_CLOSED_AUTO':
      queue.cancelTab(effect.tabId);
      effect.ptyIds.forEach((id) =>
        removePtyOnce(id, removedPtyIds, coApi.terminal.remove, 'tab-close'),
      );
      break;
    case 'PANEL_EMPTY':
      queue.cancelAll();
      panelApi.close();
      break;
  }
}

function readPersistedPanelState(value: unknown): PersistedPanelState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as PersistedPanelState;
  if (!Array.isArray(candidate.tabs)) return null;
  return candidate;
}

function newId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

function LegacyTerminalPanel() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeId = useTerminalStore((s) => s.activeId);
  const replaceSnapshot = useTerminalStore((s) => s.replaceSnapshot);
  const setActive = useTerminalStore((s) => s.setActive);

  const workspaceRoot = useWorkspaceStore((s) => s.root);
  const { resolved } = useTheme();

  const handleNew = useCallback(async () => {
    const r = await coApi.terminal.create({
      cwd: workspaceRoot ?? undefined,
      env: themedTerminalEnv(resolved),
    });
    if (!r.ok) {

      console.warn('[terminal] create failed:', r.code, r.message);
      alert(`新建终端失败:[${r.code}] ${r.message}`);
      return;
    }
    // sessions snapshot 由 main 推送;这里只更新 active 切到新 session
    setActive(r.data.id);
  }, [setActive, workspaceRoot, resolved]);

  const handleClose = useCallback((id: string) => {
    // remove = 立刻删 metadata + 异步 kill PTY(3s grace period)
    void coApi.terminal.remove(id);
  }, []);

  // 拉初始 snapshot + 订阅持续推送
  useEffect(() => {
    let cancelled = false;

    void coApi.terminal.listSessions().then((r) => {
      if (cancelled || !r.ok) return;
      replaceSnapshot(r.data.sessions as readonly TerminalSession[]);
    });

    const unsub = coApi.terminal.onSessionsChanged((snapshot) => {
      replaceSnapshot(snapshot as readonly TerminalSession[]);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [replaceSnapshot]);

  // 首次 mount 自动 spawn 一个 session(若 main 也没有)。
  // 用 module-level flag 防 StrictMode 双 mount 与异步 spawn 时序导致的双 spawn。
  // App 真重启时 module 重新加载,flag 自动复位 → 重新 spawn 一个新 terminal。
  useEffect(() => {
    if (__terminalAutoSpawned) return;
    if (useTerminalStore.getState().sessions.length > 0) {
      __terminalAutoSpawned = true;
      return;
    }
    __terminalAutoSpawned = true;
    void handleNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    // overflow-hidden:防 xterm.js 在 cols 缩小时 reflow 跳过带 ANSI 的旧行,
    // 导致 .xterm-screen 按旧 cols × cellWidth 撑大,视觉溢出穿透 dockview /
    // main / 一路跑出窗口边缘(详见 issue #15 反复修)。host 自带的
    // overflow-x-hidden 兜不住,因为问题在更外层 — main 的 flex-1 容器没设
    // overflow,子内容溢出可视区。在 TerminalPanel 顶层裁,意图清晰。
    <div className="flex h-full w-full flex-col overflow-hidden bg-canvas">
      <TerminalTabs
        onNewSession={handleNew}
        onCloseSession={handleClose}
        showTabList
      />
      <div className="relative min-h-0 flex-1">
        {sessions.map((sess) => (
          <div
            key={sess.id}
            className="absolute inset-0 flex"
            // visibility 而非 display:none — display:none 让容器变 0×0,
            // xterm fit() 算错列宽,切回 active 时 ResizeObserver / reflow
            // 时序有 race,文字按超窄列宽渲染。visibility:hidden 保留完整 layout,
            // fit 总能算对;hidden 元素不可见 + 不接收事件,UX 等价。
            style={{ visibility: sess.id === activeId ? 'visible' : 'hidden' }}
          >
            <TerminalView termId={sess.id} />
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-fg-muted">
            <div className="text-xs uppercase tracking-wider text-fg-dim">
              无活跃终端
            </div>
            <Button variant="ghost" size="md" onClick={handleNew}>
              + 新建终端
            </Button>
            <div className="text-2xs text-fg-dim">
              或点上方 Tab 栏右侧 +
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
