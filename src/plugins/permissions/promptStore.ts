// 权限授权 UI store(M-Plugin v3.4)。Promise 桥接 PromptFn。
//
// manifest permission prompt 仍保持单 pending;fs-scope prompts 用 requestId
// keyed Map 防并发串线,UI 可按 FIFO 展示 currentFsScope。

import { create } from 'zustand';
import type { PermissionKey } from '../permissions';
import type { PathScope } from '../types';

interface Pending {
  readonly pluginId: string;
  readonly perms: readonly PermissionKey[];
}

export interface FsScopePromptScope extends PathScope {
  readonly displayPath: string;
}

export interface FsScopePrompt {
  readonly requestId: string;
  readonly pluginId: string;
  readonly scopes: readonly FsScopePromptScope[];
}

interface FsScopeEntry extends FsScopePrompt {
  readonly resolve: (decision: 'grant' | 'deny') => void;
}

interface PromptState {
  pending: Pending | null;
  /** 内部 resolve;只在 pending !== null 时有值. */
  resolve: ((granted: readonly PermissionKey[]) => void) | null;
  fsScopePending: Record<string, FsScopeEntry>;
  fsScopeQueue: string[];
  currentFsScope: FsScopePrompt | null;

  request: (
    pluginId: string,
    perms: readonly PermissionKey[],
  ) => Promise<readonly PermissionKey[]>;
  grant: (perms: readonly PermissionKey[]) => void;
  denyAll: () => void;
  requestFsScope: (prompt: FsScopePrompt) => Promise<'grant' | 'deny'>;
  grantFsScope: (requestId?: string) => void;
  denyFsScope: (requestId?: string) => void;
}

function publicFsScope(entry: FsScopeEntry | undefined): FsScopePrompt | null {
  if (!entry) return null;
  return {
    requestId: entry.requestId,
    pluginId: entry.pluginId,
    scopes: entry.scopes,
  };
}

export const usePermissionPromptStore = create<PromptState>((set, get) => ({
  pending: null,
  resolve: null,
  fsScopePending: {},
  fsScopeQueue: [],
  currentFsScope: null,

  request: (pluginId, perms) => {
    if (get().pending) {
      // 已有 pending,二次 request 立即拒
      return Promise.resolve([]);
    }
    return new Promise<readonly PermissionKey[]>((resolve) => {
      set({ pending: { pluginId, perms }, resolve });
    });
  },

  grant: (perms) => {
    const { resolve } = get();
    set({ pending: null, resolve: null });
    resolve?.(perms);
  },

  denyAll: () => {
    const { resolve } = get();
    set({ pending: null, resolve: null });
    resolve?.([]);
  },

  requestFsScope: (prompt) =>
    new Promise<'grant' | 'deny'>((resolve) => {
      const state = get();
      if (state.fsScopePending[prompt.requestId]) {
        resolve('deny');
        return;
      }
      const entry: FsScopeEntry = { ...prompt, resolve };
      const nextPending = {
        ...state.fsScopePending,
        [prompt.requestId]: entry,
      };
      const nextQueue = [...state.fsScopeQueue, prompt.requestId];
      set({
        fsScopePending: nextPending,
        fsScopeQueue: nextQueue,
        currentFsScope:
          state.currentFsScope ?? publicFsScope(nextPending[nextQueue[0]!]),
      });
    }),

  grantFsScope: (requestId) => {
    resolveFsScope(get, set, requestId, 'grant');
  },

  denyFsScope: (requestId) => {
    resolveFsScope(get, set, requestId, 'deny');
  },
}));

function resolveFsScope(
  get: () => PromptState,
  set: (
    partial:
      | Partial<PromptState>
      | ((state: PromptState) => Partial<PromptState>),
  ) => void,
  requestId: string | undefined,
  decision: 'grant' | 'deny',
): void {
  const state = get();
  const id = requestId ?? state.currentFsScope?.requestId;
  if (!id) return;
  const entry = state.fsScopePending[id];
  if (!entry) return;
  const nextPending = { ...state.fsScopePending };
  delete nextPending[id];
  const nextQueue = state.fsScopeQueue.filter((x) => x !== id);
  set({
    fsScopePending: nextPending,
    fsScopeQueue: nextQueue,
    currentFsScope: publicFsScope(nextPending[nextQueue[0]!]),
  });
  entry.resolve(decision);
}
