import {
  collectLeaves,
  collectPtyIdsFromPane,
  hydratePaneNode,
  paneTreeReducer,
  serializePaneNode,
  type PaneNode,
  type PaneNodePersisted,
  type PaneTreeAction,
  type SpawnReason,
} from './paneTree';

export type {
  LeafNode,
  LeafPersisted,
  PaneNode,
  PaneNodePersisted,
  PaneTreeAction,
  SplitDirection,
  SplitNode,
  SplitPersisted,
} from './paneTree';

export interface PersistedTab {
  id: string;
  title: string;
  paneTree: PaneNodePersisted;
  primaryLeafId: string;
  paneTreeVersion: 1;
  /** 持久化 tab 所属 workspace.root,用于跨 workspace 切换时过滤显示。 */
  workspaceRoot?: string;
}

export interface PersistedPanelState {
  tabs: PersistedTab[];
  activeTabId: string;
}

export interface TabState {
  id: string;
  title: string;
  paneTree: PaneNode;
  activeLeafId?: string;
  primaryLeafId: string;
  paneTreeVersion: 1;
  /** topic-05: agent attach 自报来源 */
  originHint?: 'user' | 'agent';
  agentLabel?: string;
  /**
   * 创建/attach 时所在 workspace.root;undefined = 全局(所有 workspace 都渲染)。
   * Render 侧用 `t.workspaceRoot === current || t.workspaceRoot === undefined`
   * 过滤当前可见 tabs;hidden tabs 仍在 state 里保活,切回 workspace 即恢复。
   */
  workspaceRoot?: string;
}

export interface PanelState {
  tabs: TabState[];
  activeTabId: string | null;
  hydrated: boolean;
}

export type AttachTarget =
  | { kind: 'panel'; panelId: string }
  | { kind: 'window'; windowId: number }
  | { kind: 'active' };

export type DetachRejectionReason = 'split-tab' | 'not-found';

export type AttachRejectionReason = 'limit' | 'duplicate' | 'no-target';

export type PanelEffect =
  | { type: 'LEAF_CLOSED'; tabId: string; leafId: string; ptyId: string }
  | { type: 'TAB_CLOSED_AUTO'; tabId: string; ptyIds: string[] }
  | { type: 'PANEL_EMPTY' }
  | { type: 'PANEL_EMPTY_DEFERRED' }
  | { type: 'TAB_DETACHED'; tabId: string; leafSnapshot: import('./paneTree').LeafNode }
  | { type: 'TAB_DETACH_REJECTED'; tabId: string; reason: DetachRejectionReason }
  | { type: 'TAB_ATTACH_REJECTED'; ptyId: string; reason: AttachRejectionReason }
  | {
      type: 'ENQUEUE_SPAWN';
      tabId: string;
      leafId: string;
      cwd?: string;
      scoped: boolean;
      reason: SpawnReason;
      workspaceRoot?: string;
    };

// 每 panel 内嵌 tab 上限,超出时 ATTACH_EXISTING_PTY_AS_TAB 在 reducer 端拒。
// main 端 reserveAttachSlot 是真防线;这里是兜底。
export const PANEL_TAB_LIMIT = 20;

export type PanelAction =
  | { type: 'HYDRATE'; persisted: PersistedPanelState }
  | {
      type: 'ADD_TAB';
      tabId: string;
      primaryLeafId: string;
      title: string;
      cwd?: string;
      workspaceRoot?: string;
    }
  | {
      type: 'ATTACH_EXISTING_PTY_AS_TAB';
      tabId: string;
      primaryLeafId: string;
      title: string;
      ptyId: string;
      cwd?: string;
      originHint?: 'user' | 'agent';
      agentLabel?: string;
      workspaceRoot?: string;
    }
  | { type: 'DETACH_TAB'; tabId: string; forMove?: boolean }
  | { type: 'CLOSE_TAB'; tabId: string }
  | { type: 'SELECT_TAB'; tabId: string }
  | { type: 'PANE_ACTION'; tabId: string; action: PaneTreeAction };

export interface ReducerResult {
  state: PanelState;
  effects: PanelEffect[];
}

export function panelReducer(
  state: PanelState,
  action: PanelAction,
): ReducerResult {
  switch (action.type) {
    case 'HYDRATE': {
      console.debug('[pane-split] hydrate-start');
      const tabs = action.persisted.tabs.map(hydrateTab);
      const activeTabId =
        tabs.find((tab) => tab.id === action.persisted.activeTabId)?.id ??
        tabs[0]?.id ??
        null;
      const effects = tabs.flatMap((tab) =>
        collectLeaves(tab.paneTree).map<PanelEffect>((leaf) => ({
          type: 'ENQUEUE_SPAWN',
          tabId: tab.id,
          leafId: leaf.id,
          cwd: leaf.cwd,
          scoped: true,
          reason: 'hydrate',
          ...(tab.workspaceRoot !== undefined ? { workspaceRoot: tab.workspaceRoot } : {}),
        })),
      );
      return {
        state: { tabs, activeTabId, hydrated: true },
        effects,
      };
    }
    case 'ATTACH_EXISTING_PTY_AS_TAB': {
      // 上限兜底(真防线在 main 端 reserveAttachSlot)
      if (state.tabs.length >= PANEL_TAB_LIMIT) {
        return {
          state,
          effects: [
            { type: 'TAB_ATTACH_REJECTED', ptyId: action.ptyId, reason: 'limit' },
          ],
        };
      }
      // duplicate ptyId 兜底
      const existing = state.tabs.find((t) =>
        collectPtyIdsFromPane(t.paneTree).includes(action.ptyId),
      );
      if (existing) {
        return {
          state,
          effects: [
            { type: 'TAB_ATTACH_REJECTED', ptyId: action.ptyId, reason: 'duplicate' },
          ],
        };
      }
      const leaf = {
        kind: 'leaf' as const,
        id: action.primaryLeafId,
        ptyId: action.ptyId,
        cwd: action.cwd,
        spawnPending: false,
      };
      const tab: TabState = {
        id: action.tabId,
        title: action.title,
        paneTree: leaf,
        activeLeafId: action.primaryLeafId,
        primaryLeafId: action.primaryLeafId,
        paneTreeVersion: 1,
        ...(action.originHint !== undefined ? { originHint: action.originHint } : {}),
        ...(action.agentLabel !== undefined ? { agentLabel: action.agentLabel } : {}),
        ...(action.workspaceRoot !== undefined ? { workspaceRoot: action.workspaceRoot } : {}),
      };
      return {
        state: {
          ...state,
          tabs: [...state.tabs, tab],
          activeTabId: action.tabId,
        },
        // 关键:不 emit ENQUEUE_SPAWN,因为 ptyId 已绑定。
        effects: [],
      };
    }
    case 'DETACH_TAB': {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (!tab) {
        return {
          state,
          effects: [
            { type: 'TAB_DETACH_REJECTED', tabId: action.tabId, reason: 'not-found' },
          ],
        };
      }
      // V1 限制:只允许 detach paneTree 是单 leaf 的 tab(split tab 拖动太复杂,
      // dragstart 阶段已 preventDefault 拒;到这里属于兜底)。
      if (tab.paneTree.kind !== 'leaf') {
        return {
          state,
          effects: [
            { type: 'TAB_DETACH_REJECTED', tabId: action.tabId, reason: 'split-tab' },
          ],
        };
      }
      const leafSnapshot = tab.paneTree;
      const tabs = state.tabs.filter((t) => t.id !== action.tabId);
      const activeTabId =
        state.activeTabId === action.tabId
          ? tabs[Math.min(state.tabs.indexOf(tab), tabs.length - 1)]?.id ?? null
          : state.activeTabId;
      const effects: PanelEffect[] = [
        { type: 'TAB_DETACHED', tabId: action.tabId, leafSnapshot },
      ];
      if (tabs.length === 0) {
        // P0-4:forMove 时延迟关 panel,让 caller 完成 addPanel 后再关
        effects.push(
          action.forMove === true ? { type: 'PANEL_EMPTY_DEFERRED' } : { type: 'PANEL_EMPTY' },
        );
      }
      console.debug('[tab-drag] DETACH_TAB', action.tabId, 'forMove=', action.forMove === true);
      return { state: { ...state, tabs, activeTabId }, effects };
    }
    case 'ADD_TAB': {
      const leaf = {
        kind: 'leaf' as const,
        id: action.primaryLeafId,
        cwd: action.cwd,
        spawnPending: true,
      };
      const tab: TabState = {
        id: action.tabId,
        title: action.title,
        paneTree: leaf,
        activeLeafId: action.primaryLeafId,
        primaryLeafId: action.primaryLeafId,
        paneTreeVersion: 1,
        ...(action.workspaceRoot !== undefined ? { workspaceRoot: action.workspaceRoot } : {}),
      };
      return {
        state: {
          ...state,
          tabs: [...state.tabs, tab],
          activeTabId: action.tabId,
        },
        effects: [
          {
            type: 'ENQUEUE_SPAWN',
            tabId: action.tabId,
            leafId: action.primaryLeafId,
            cwd: action.cwd,
            scoped: true,
            reason: 'addTab',
            ...(action.workspaceRoot !== undefined ? { workspaceRoot: action.workspaceRoot } : {}),
          },
        ],
      };
    }
    case 'CLOSE_TAB': {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (!tab) return { state, effects: [] };
      const ptyIds = collectPtyIdsFromPane(tab.paneTree);
      const tabs = state.tabs.filter((t) => t.id !== action.tabId);
      const activeTabId =
        state.activeTabId === action.tabId
          ? tabs[Math.min(state.tabs.indexOf(tab), tabs.length - 1)]?.id ?? null
          : state.activeTabId;
      const effects: PanelEffect[] = [
        { type: 'TAB_CLOSED_AUTO', tabId: action.tabId, ptyIds },
      ];
      if (tabs.length === 0) effects.push({ type: 'PANEL_EMPTY' });
      console.debug('[pane-split] TAB_CLOSED_AUTO', action.tabId, ptyIds);
      return { state: { ...state, tabs, activeTabId }, effects };
    }
    case 'SELECT_TAB':
      if (!state.tabs.some((tab) => tab.id === action.tabId)) {
        return { state, effects: [] };
      }
      return { state: { ...state, activeTabId: action.tabId }, effects: [] };
    case 'PANE_ACTION': {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (!tab) return { state, effects: [] };
      if (action.action.type === 'SPLIT') {
        console.debug('[pane-split] SPLIT', action.tabId, action.action.leafId);
      }
      const result = paneTreeReducer(
        { tree: tab.paneTree, activeLeafId: tab.activeLeafId },
        action.action,
      );
      const effects = upgradePaneEffects(action.tabId, result.effects, tab.workspaceRoot);
      if (!result.tree) {
        const ptyIds = collectPtyIdsFromPane(tab.paneTree);
        const tabs = state.tabs.filter((t) => t.id !== tab.id);
        effects.push({ type: 'TAB_CLOSED_AUTO', tabId: tab.id, ptyIds });
        console.debug('[pane-split] TAB_CLOSED_AUTO', tab.id, ptyIds);
        if (tabs.length === 0) {
          effects.push({ type: 'PANEL_EMPTY' });
          console.debug('[pane-split] PANEL_EMPTY');
        }
        return {
          state: {
            ...state,
            tabs,
            activeTabId:
              state.activeTabId === tab.id ? tabs[0]?.id ?? null : state.activeTabId,
          },
          effects,
        };
      }
      const nextTab: TabState = {
        ...tab,
        paneTree: result.tree,
        activeLeafId: result.activeLeafId,
      };
      return {
        state: {
          ...state,
          tabs: state.tabs.map((t) => (t.id === tab.id ? nextTab : t)),
        },
        effects,
      };
    }
  }
}

export function serializeTabsStateForPersistence(
  state: PanelState,
): PersistedPanelState {
  const tabs = state.tabs.map<PersistedTab>((tab) => ({
    id: tab.id,
    title: tab.title,
    paneTree: serializePaneNode(tab.paneTree),
    primaryLeafId: tab.primaryLeafId,
    paneTreeVersion: 1,
    ...(tab.workspaceRoot !== undefined ? { workspaceRoot: tab.workspaceRoot } : {}),
  }));
  return { tabs, activeTabId: state.activeTabId ?? tabs[0]?.id ?? '' };
}

export function collectPanelPtyIds(state: PanelState): string[] {
  return state.tabs.flatMap((tab) => collectPtyIdsFromPane(tab.paneTree));
}

export function findTab(
  state: PanelState,
  tabId: string | null | undefined,
): TabState | undefined {
  if (!tabId) return undefined;
  return state.tabs.find((tab) => tab.id === tabId);
}

export function defaultPersistedState(cwd?: string): PersistedPanelState {
  return {
    activeTabId: 'tab-default',
    tabs: [
      {
        id: 'tab-default',
        title: 'Terminal',
        primaryLeafId: 'leaf-default',
        paneTreeVersion: 1,
        paneTree: { kind: 'leaf', id: 'leaf-default', cwd },
      },
    ],
  };
}

function hydrateTab(tab: PersistedTab): TabState {
  const paneTree = hydratePaneNode(tab.paneTree);
  return {
    id: tab.id,
    title: tab.title,
    paneTree,
    activeLeafId:
      collectLeaves(paneTree).find((leaf) => leaf.id === tab.primaryLeafId)?.id ??
      collectLeaves(paneTree)[0]?.id,
    primaryLeafId: tab.primaryLeafId,
    paneTreeVersion: 1,
    ...(tab.workspaceRoot !== undefined ? { workspaceRoot: tab.workspaceRoot } : {}),
  };
}

function upgradePaneEffects(
  tabId: string,
  effects: import('./paneTree').PaneTreeEffect[],
  workspaceRoot?: string,
): PanelEffect[] {
  return effects.map((effect) => {
    if (effect.type === 'LEAF_CLOSED') {
      console.debug('[pane-split] LEAF_CLOSED', tabId, effect.leafId, effect.ptyId);
      return { ...effect, tabId };
    }
    // SPLIT 出的新 leaf 也属于 tab 的 workspace,透传给 main session metadata。
    return {
      ...effect,
      tabId,
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    };
  });
}
