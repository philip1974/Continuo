// 权限授权 UI store(M-Plugin v3.4)。Promise 桥接 PromptFn。
//
// manifest permission prompt 仍保持单 pending;fs-scope prompts 用 requestId
// keyed Map 防并发串线,UI 可按 FIFO 展示 currentFsScope。

import { create } from 'zustand';
import type { PermissionKey } from '../permissions';
import type { PathScope } from '../types';

export interface Pending {
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

// race(R89,R88 同型):main scope-request-correlator 的 TTL(DEFAULT_TTL_MS=300_000)到点只在
// main 端 reject pending,不通知 renderer 清 prompt。renderer 若不同 TTL 自清,过期的 fs-scope
// 弹窗会滞留为 currentFsScope,把后续排队的 scope 请求挡在它后面永不显示(插件侧均超时)。
// 每个 request 挂同 TTL 本地超时:过期且仍 pending → 按 deny 收口(resolveFsScope 会推进队列)。
const FS_SCOPE_TTL_MS = 300_000;
const fsScopeTimers = new Map<string, ReturnType<typeof setTimeout>>();
function clearFsScopeTimer(requestId: string): void {
  const timer = fsScopeTimers.get(requestId);
  if (timer !== undefined) {
    clearTimeout(timer);
    fsScopeTimers.delete(requestId);
  }
}

function publicFsScope(entry: FsScopeEntry | undefined): FsScopePrompt | null {
  if (!entry) return null;
  return {
    requestId: entry.requestId,
    pluginId: entry.pluginId,
    scopes: entry.scopes,
  };
}

export function removeFsScopeQueueId(
  queue: string[],
  id: string,
): string[] {
  let next: string[] | null = null;
  let count = 0;
  for (let i = 0; i < queue.length; i++) {
    const queuedId = queue[i]!;
    if (queuedId === id) {
      if (next === null) {
        next = new Array<string>(queue.length - 1);
        for (let j = 0; j < i; j++) {
          next[j] = queue[j]!;
        }
        count = i;
      }
      continue;
    }
    if (next !== null) next[count++] = queuedId;
  }
  if (next !== null) next.length = count;
  return next ?? queue;
}

export function appendFsScopeQueueId(queue: readonly string[], id: string): string[] {
  const next = new Array<string>(queue.length + 1);
  for (let i = 0; i < queue.length; i++) next[i] = queue[i]!;
  next[queue.length] = id;
  return next;
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
      const nextQueue = appendFsScopeQueueId(state.fsScopeQueue, prompt.requestId);
      set({
        fsScopePending: nextPending,
        fsScopeQueue: nextQueue,
        currentFsScope:
          state.currentFsScope ?? publicFsScope(nextPending[nextQueue[0]!]),
      });
      // race(R89):同 main TTL 的本地超时。过期且仍 pending → 按 deny 收口(清该请求 + 推进队列),
      // 避免过期弹窗滞留挡住后续 scope 请求。grant/deny(resolveFsScope)会 clearFsScopeTimer。
      clearFsScopeTimer(prompt.requestId);
      fsScopeTimers.set(
        prompt.requestId,
        setTimeout(() => {
          fsScopeTimers.delete(prompt.requestId);
          if (get().fsScopePending[prompt.requestId]) {
            resolveFsScope(get, set, prompt.requestId, 'deny');
          }
        }, FS_SCOPE_TTL_MS),
      );
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
  clearFsScopeTimer(id); // race(R89):resolved → 清本地超时,防误触/泄漏
  const nextPending = { ...state.fsScopePending };
  delete nextPending[id];
  const nextQueue = removeFsScopeQueueId(state.fsScopeQueue, id);
  set({
    fsScopePending: nextPending,
    fsScopeQueue: nextQueue,
    currentFsScope: publicFsScope(nextPending[nextQueue[0]!]),
  });
  entry.resolve(decision);
}
