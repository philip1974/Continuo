// 权限授权 UI store(M-Plugin v3.4)。Promise 桥接 PromptFn。
//
// 同时只能一个 pending,二次 request 直接 resolve([])(避免堆叠 modal)。

import { create } from 'zustand';
import type { PermissionKey } from '../permissions';

interface Pending {
  readonly pluginId: string;
  readonly perms: readonly PermissionKey[];
}

interface PromptState {
  pending: Pending | null;
  /** 内部 resolve;只在 pending !== null 时有值. */
  resolve: ((granted: readonly PermissionKey[]) => void) | null;

  request: (
    pluginId: string,
    perms: readonly PermissionKey[],
  ) => Promise<readonly PermissionKey[]>;
  grant: (perms: readonly PermissionKey[]) => void;
  denyAll: () => void;
}

export const usePermissionPromptStore = create<PromptState>((set, get) => ({
  pending: null,
  resolve: null,

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
}));
