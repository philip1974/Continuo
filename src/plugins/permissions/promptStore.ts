// 权限授权 UI store(M-Plugin v3.4)。Promise 桥接 PromptFn。
//
// manifest permission prompt 仍保持单 pending;fs-scope prompts 用 requestId
// keyed Map 防并发串线,UI 可按 FIFO 展示 currentFsScope。

import { create } from 'zustand';
import type { PermissionKey } from '../permissions';
import type { PathScope } from '../types';
import { filterKeepingIdentity } from '@/lib/filter-keeping-identity';

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
  /**
   * 取消某插件的 manifest 授权弹窗(当前显示的 + 排队中的):对应 request 以 reason reject(终审 P1:插件已被别的
   * 窗口卸载)。reject 而非 resolve([]):调用方 ensureAuthorized 把空数组当「用户全拒」写盘,取消不得写任何决策。
   */
  cancel: (pluginId: string, reason: unknown) => void;
  requestFsScope: (prompt: FsScopePrompt) => Promise<'grant' | 'deny'>;
  grantFsScope: (requestId: string) => void;
  denyFsScope: (requestId: string) => void;
}

// fs-scope 请求的过期不在这里计时:usePluginFsScopeRequests 在队首开始显示时回报 main,main 的
// scope-request-correlator 从那时起计无应答超时(排队另有兜底上限);到点 / 插件注销时发
// SCOPE_REQUEST_CANCELLED,usePluginFsScopeRequests 收到后调 denyFsScope 撤弹窗并推进队列。
const EMPTY_FS_SCOPE_QUEUE: string[] = [];

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
  if (queue.length === 0) return EMPTY_FS_SCOPE_QUEUE;
  return filterKeepingIdentity(queue, (queuedId) => queuedId !== id, EMPTY_FS_SCOPE_QUEUE);
}

export function appendFsScopeQueueId(queue: readonly string[], id: string): string[] {
  const next = new Array<string>(queue.length + 1);
  for (let i = 0; i < queue.length; i++) next[i] = queue[i]!;
  next[queue.length] = id;
  return next;
}

// 等待弹出的 manifest 权限请求(弹窗一次只显示一个;fs-scope 请求有自己的队列)。
const manifestPromptQueue: Array<{
  pluginId: string;
  perms: readonly PermissionKey[];
  resolve: (granted: readonly PermissionKey[]) => void;
  reject: (reason: unknown) => void;
}> = [];
/** 当前显示的 manifest 弹窗的 reject(与 state.resolve 成对;cancel 用)。 */
let currentManifestReject: ((reason: unknown) => void) | null = null;
const EMPTY_GRANTED_PERMS: readonly PermissionKey[] = [];

/** 关闭当前 manifest 弹窗并弹出队列里的下一个(若有);返回被关闭弹窗的 resolve / reject。无 pending → null。 */
function advanceManifestPrompt(
  get: () => PromptState,
  set: (partial: Partial<PromptState>) => void,
): {
  resolve: ((granted: readonly PermissionKey[]) => void) | null;
  reject: ((reason: unknown) => void) | null;
} | null {
  const { resolve, pending } = get();
  if (!resolve && pending === null) return null;
  const reject = currentManifestReject;
  const next = manifestPromptQueue.shift();
  currentManifestReject = next?.reject ?? null;
  set(
    next
      ? { pending: { pluginId: next.pluginId, perms: next.perms }, resolve: next.resolve }
      : { pending: null, resolve: null },
  );
  return { resolve, reject };
}

/** 结算当前 manifest 弹窗,并弹出队列里的下一个(若有)。无 pending → no-op。 */
function settleManifestPrompt(
  get: () => PromptState,
  set: (partial: Partial<PromptState>) => void,
  granted: readonly PermissionKey[],
): void {
  advanceManifestPrompt(get, set)?.resolve?.(granted);
}

export const usePermissionPromptStore = create<PromptState>((set, get) => ({
  pending: null,
  resolve: null,
  fsScopePending: {},
  fsScopeQueue: EMPTY_FS_SCOPE_QUEUE,
  currentFsScope: null,

  request: (pluginId, perms) =>
    new Promise<readonly PermissionKey[]>((resolve, reject) => {
      if (get().pending) {
        // 弹窗被占用 → 排队,不结算。不能返回 []:调用方(ensureAuthorized)把空数组当「用户全拒」
        // 并持久化,另一个插件的权限会在用户从未见到弹窗的情况下被永久拒绝。
        manifestPromptQueue.push({ pluginId, perms, resolve, reject });
        return;
      }
      currentManifestReject = reject;
      set({ pending: { pluginId, perms }, resolve });
    }),

  grant: (perms) => settleManifestPrompt(get, set, perms),

  denyAll: () => settleManifestPrompt(get, set, EMPTY_GRANTED_PERMS),

  cancel: (pluginId, reason) => {
    for (let i = manifestPromptQueue.length - 1; i >= 0; i--) {
      const queued = manifestPromptQueue[i]!;
      if (queued.pluginId !== pluginId) continue;
      manifestPromptQueue.splice(i, 1);
      queued.reject(reason);
    }
    if (get().pending?.pluginId === pluginId) {
      advanceManifestPrompt(get, set)?.reject?.(reason);
    }
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
  id: string,
  decision: 'grant' | 'deny',
): void {
  const state = get();
  const entry = state.fsScopePending[id];
  if (!entry) return;
  const nextPending = { ...state.fsScopePending };
  delete nextPending[id];
  const nextQueue = removeFsScopeQueueId(state.fsScopeQueue, id);
  const nextCurrentId = nextQueue[0];
  const current =
    state.currentFsScope?.requestId === nextCurrentId
      ? state.currentFsScope
      : publicFsScope(nextPending[nextCurrentId!]);
  set({
    fsScopePending: nextPending,
    fsScopeQueue: nextQueue,
    currentFsScope: current,
  });
  entry.resolve(decision);
}
