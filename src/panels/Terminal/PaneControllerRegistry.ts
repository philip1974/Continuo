import {
  collectPanelPtyIds,
  findTab,
  PANEL_TAB_LIMIT,
  type PanelAction,
  type PanelEffect,
  type PanelState,
} from './panelReducer';
import { findLeaf, type LeafNode, type SplitDirection } from './paneTree';

export type DetachOutcome =
  | { detached: true; leafSnapshot: LeafNode }
  | { detached: false; reason: 'split-tab' | 'not-found' | 'not-leaf' };

export type AttachOutcome =
  | { attached: true; tabId: string }
  | { attached: false; reason: 'limit' | 'duplicate' | 'not-hydrated' };

export interface AttachExistingPtyInput {
  ptyId: string;
  title: string;
  cwd?: string;
  originHint?: 'user' | 'agent';
  agentLabel?: string;
  /** session 自带的 workspace tag(undefined = 全局,所有 workspace 可见)。 */
  workspaceRoot?: string;
}

export interface PaneController {
  panelId: string;
  windowId: number;
  dispatch: (action: PanelAction) => void;
  getCurrentTabId: () => string | undefined;
  getCurrentPtyIds: () => string[];
  getActiveLeafId: () => string | undefined;
  getTabCount: () => number;
  isHydrated: () => boolean;
  split: (direction: SplitDirection) => void;
  focusPrev: () => void;
  focusNext: () => void;
  /** topic-05: 拖拽 detach,forMove=true 抑制 PANEL_EMPTY auto-close */
  detachTab: (tabId: string, opts: { forMove: boolean }) => DetachOutcome;
  /** topic-05: agent session 已有 ptyId,绑成新 tab(不 spawn) */
  tryAttachExisting: (input: AttachExistingPtyInput) => AttachOutcome;
  /** topic-05: drop 序列完成后,如果原 panel 空了就关 */
  closeIfStillEmpty: () => void;
}

export interface CreatePaneControllerInput {
  panelId: string;
  windowId: number;
  dispatch: (action: PanelAction) => void;
  dispatchAndCollect: (action: PanelAction) => PanelEffect[];
  stateRef: { current: PanelState };
  removedPtyIds: Set<string>;
  closePanel: () => void;
}

type Listener = () => void;

const controllers = new Map<string, PaneController>();
const listeners = new Set<Listener>();

export function createPaneController({
  panelId,
  windowId,
  dispatch,
  dispatchAndCollect,
  stateRef,
  removedPtyIds,
  closePanel,
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
    getTabCount: () => stateRef.current.tabs.length,
    isHydrated: () => stateRef.current.hydrated,
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
    detachTab: (tabId, opts) => {
      // 同步取 effects;不进 effectQueueRef(避免 caller 与 panel effect-flush 竞争)
      const effects = dispatchAndCollect({ type: 'DETACH_TAB', tabId, forMove: opts.forMove });
      const detached = effects.find((e) => e.type === 'TAB_DETACHED');
      if (detached && detached.type === 'TAB_DETACHED') {
        return { detached: true, leafSnapshot: detached.leafSnapshot };
      }
      const rejected = effects.find((e) => e.type === 'TAB_DETACH_REJECTED');
      if (rejected && rejected.type === 'TAB_DETACH_REJECTED') {
        return { detached: false, reason: rejected.reason };
      }
      return { detached: false, reason: 'not-found' };
    },
    tryAttachExisting: (input) => {
      if (!stateRef.current.hydrated) {
        return { attached: false, reason: 'not-hydrated' };
      }
      if (stateRef.current.tabs.length >= PANEL_TAB_LIMIT) {
        return { attached: false, reason: 'limit' };
      }
      const tabId = newId('tab');
      const leafId = newId('leaf');
      const effects = dispatchAndCollect({
        type: 'ATTACH_EXISTING_PTY_AS_TAB',
        tabId,
        primaryLeafId: leafId,
        title: input.title,
        ptyId: input.ptyId,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.originHint !== undefined ? { originHint: input.originHint } : {}),
        ...(input.agentLabel !== undefined ? { agentLabel: input.agentLabel } : {}),
        ...(input.workspaceRoot !== undefined
          ? { workspaceRoot: input.workspaceRoot }
          : {}),
      });
      const rejected = effects.find((e) => e.type === 'TAB_ATTACH_REJECTED');
      if (rejected && rejected.type === 'TAB_ATTACH_REJECTED') {
        return {
          attached: false,
          reason: rejected.reason === 'no-target' ? 'limit' : rejected.reason,
        };
      }
      return { attached: true, tabId };
    },
    closeIfStillEmpty: () => {
      if (stateRef.current.tabs.length === 0) {
        console.debug('[tab-drag] CLOSE_IF_EMPTY panel', panelId);
        closePanel();
      }
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
