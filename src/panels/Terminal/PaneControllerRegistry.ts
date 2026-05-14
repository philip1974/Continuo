import { collectPanelPtyIds, findTab, type PanelAction, type PanelState } from './panelReducer';
import { findLeaf, type SplitDirection } from './paneTree';

export interface PaneController {
  panelId: string;
  windowId: number;
  dispatch: (action: PanelAction) => void;
  getCurrentTabId: () => string | undefined;
  getCurrentPtyIds: () => string[];
  getActiveLeafId: () => string | undefined;
  split: (direction: SplitDirection) => void;
  focusPrev: () => void;
  focusNext: () => void;
}

export interface CreatePaneControllerInput {
  panelId: string;
  windowId: number;
  dispatch: (action: PanelAction) => void;
  stateRef: { current: PanelState };
  removedPtyIds: Set<string>;
}

type Listener = () => void;

const controllers = new Map<string, PaneController>();
const listeners = new Set<Listener>();

export function createPaneController({
  panelId,
  windowId,
  dispatch,
  stateRef,
  removedPtyIds,
}: CreatePaneControllerInput): PaneController {
  const currentTab = () => findTab(stateRef.current, stateRef.current.activeTabId);
  const controller: PaneController = {
    panelId,
    windowId,
    dispatch,
    getCurrentTabId: () => stateRef.current.activeTabId ?? undefined,
    getCurrentPtyIds: () =>
      collectPanelPtyIds(stateRef.current).filter((id) => !removedPtyIds.has(id)),
    getActiveLeafId: () => currentTab()?.activeLeafId,
    split: (direction) => {
      const tab = currentTab();
      if (!tab?.activeLeafId) return;
      const leaf = findLeaf(tab.paneTree, tab.activeLeafId);
      const newLeafId = newId('leaf');
      dispatch({
        type: 'PANE_ACTION',
        tabId: tab.id,
        action: {
          type: 'SPLIT',
          leafId: tab.activeLeafId,
          dir: direction,
          newLeafId,
          newCwd: leaf?.cwd,
        },
      });
    },
    focusPrev: () => {
      const tabId = stateRef.current.activeTabId;
      if (!tabId) return;
      dispatch({ type: 'PANE_ACTION', tabId, action: { type: 'FOCUS_PREV' } });
    },
    focusNext: () => {
      const tabId = stateRef.current.activeTabId;
      if (!tabId) return;
      dispatch({ type: 'PANE_ACTION', tabId, action: { type: 'FOCUS_NEXT' } });
    },
  };
  return controller;
}

export function registerPaneController(
  windowId: number,
  panelId: string,
  controller: PaneController,
): () => void {
  const key = registryKey(windowId, panelId);
  controllers.set(key, controller);
  notify();
  return () => {
    if (controllers.get(key) === controller) {
      controllers.delete(key);
      notify();
    }
  };
}

export function getPaneController(
  windowId: number,
  panelId: string,
): PaneController | undefined {
  return controllers.get(registryKey(windowId, panelId));
}

export function getPaneControllersForWindow(windowId: number): PaneController[] {
  return Array.from(controllers.values()).filter(
    (controller) => controller.windowId === windowId,
  );
}

export function subscribePaneControllers(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function _clearPaneControllerRegistryForTest(): void {
  controllers.clear();
  notify();
}

function registryKey(windowId: number, panelId: string): string {
  return `${windowId}:${panelId}`;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

function newId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}
