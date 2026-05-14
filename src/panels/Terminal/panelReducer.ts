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
}

export interface PanelState {
  tabs: TabState[];
  activeTabId: string | null;
  hydrated: boolean;
}

export type PanelEffect =
  | { type: 'LEAF_CLOSED'; tabId: string; leafId: string; ptyId: string }
  | { type: 'TAB_CLOSED_AUTO'; tabId: string; ptyIds: string[] }
  | { type: 'PANEL_EMPTY' }
  | {
      type: 'ENQUEUE_SPAWN';
      tabId: string;
      leafId: string;
      cwd?: string;
      scoped: boolean;
      reason: SpawnReason;
    };

export type PanelAction =
  | { type: 'HYDRATE'; persisted: PersistedPanelState }
  | {
      type: 'ADD_TAB';
      tabId: string;
      primaryLeafId: string;
      title: string;
      cwd?: string;
    }
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
        })),
      );
      return {
        state: { tabs, activeTabId, hydrated: true },
        effects,
      };
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
      const effects = upgradePaneEffects(action.tabId, result.effects);
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
  };
}

function upgradePaneEffects(
  tabId: string,
  effects: import('./paneTree').PaneTreeEffect[],
): PanelEffect[] {
  return effects.map((effect) => {
    if (effect.type === 'LEAF_CLOSED') {
      console.debug('[pane-split] LEAF_CLOSED', tabId, effect.leafId, effect.ptyId);
      return { ...effect, tabId };
    }
    return { ...effect, tabId };
  });
}
