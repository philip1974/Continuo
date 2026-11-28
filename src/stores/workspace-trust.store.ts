// 本窗口工作区信任状态的界面副本(权威在 main,见 electron/main/services/workspace-trust.service)。main 在换根 / 信任变化时推送
// { root, trusted };这里只决定界面:状态栏「受限模式」项、授权弹窗的「此文件夹不受信任」提示、git 装饰的刷新时机。
// git 是否运行由 main 在 git:status 里把关,不依赖这份副本。
// BDD: src/__tests__/workspace-trust/

import { create } from 'zustand';
import { coApi } from '@/lib/co-api';
import { pathEquals } from '@/lib/path-cross';
import type { WorkspaceTrustState } from '../../electron/shared/workspace-trust';

interface WorkspaceTrustStore {
  /** main 最近推送的状态;null = 尚未收到(启动中)。 */
  readonly state: WorkspaceTrustState | null;
  /** 管理工作区信任对话框是否打开。 */
  readonly manageOpen: boolean;
  readonly setManageOpen: (open: boolean) => void;
}

export const useWorkspaceTrustStore = create<WorkspaceTrustStore>((set) => ({
  state: null,
  manageOpen: false,
  setManageOpen: (open) => set({ manageOpen: open }),
}));

/** root 是否已知处于受限模式(main 推来的状态针对的就是这个根,且未受信任)。尚未收到 / 别的根 → false。 */
export function isRestrictedRoot(state: WorkspaceTrustState | null, root: string | null): boolean {
  return state !== null && root !== null && state.root !== null && pathEquals(state.root, root) && !state.trusted;
}

let unsubscribe: (() => void) | null = null;

/** 订阅 main 推送(main-app init 调一次,早于 App 上报 root;模块级幂等)。 */
export function startWorkspaceTrustSync(): void {
  if (unsubscribe) return;
  unsubscribe = coApi.workspaceTrust.onChanged((state) => useWorkspaceTrustStore.setState({ state }));
}
