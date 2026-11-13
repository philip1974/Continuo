// 「弹原生目录选择器 → 切 workspace root」的共享流程(重构:EmptyWorkspace 的「打开文件夹」与
// ExplorerHeader 的「切换文件夹」此前逐行复制;R106 单飞闸门、R27 过期守卫、A146 失败反馈每次都要
// 两边同步)。
//
//   - race(R106,R8 同族):busy 是异步 state,同 tick 双击/Enter 在 disabled 渲染前会发起多个
//     selectDirectory()。同步单飞闸门立即挡掉并发(全 app 同时只一个原生目录选择器,与
//     WindowPlugin「在新窗口打开文件夹」共享同一把锁)。
//   - race(R27):全窗口共享的 workspaceRootSelectionGuard,与 drop / 打开最近 互相失效。本次对话框
//     结果落地前若别的入口发起了新选择,则本次过期 → 不 setRoot、不报错。
//   - a11y(A146,A141 同族):取消(ok + 无 data)是正常 no-op;但 !r.ok / reject 须 notify,否则
//     控件退出 busy 却无 toast/live region 反馈,用户不知为何没切。

import { useCallback, useRef, useState } from 'react';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { coApi } from '@/lib/co-api';
import { workspaceRootSelectionGuard } from '@/lib/workspace-root-guard';
import {
  trySelectDirectoryLock,
  releaseSelectDirectoryLock,
} from '@/lib/select-directory-single-flight';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';

export interface SelectWorkspaceFolder {
  /** 选择器打开中(控件据此 disabled / aria-busy)。 */
  readonly busy: boolean;
  /**
   * 发起选择。`onStart` 在拿到单飞锁之后、弹对话框之前同步调用(ExplorerHeader 用它关菜单并
   * 还原焦点);被 busy / 单飞锁挡掉时不调用。
   */
  readonly selectFolder: (onStart?: () => void) => Promise<void>;
}

export function useSelectWorkspaceFolder(): SelectWorkspaceFolder {
  const setRoot = useWorkspaceStore((s) => s.setRoot);
  const [busy, setBusy] = useState(false);
  // 与 busy state 同步的即时值:selectFolder 引用稳定,又能在同一渲染帧内读到最新 busy。
  const busyRef = useRef(false);

  const selectFolder = useCallback(
    async (onStart?: () => void): Promise<void> => {
      if (busyRef.current) return;
      if (!trySelectDirectoryLock()) return;
      onStart?.();
      busyRef.current = true;
      setBusy(true);
      const isLatest = workspaceRootSelectionGuard.begin();
      try {
        const r = await coApi.fs.selectDirectory();
        if (!isLatest()) return;
        if (r.ok && r.data) setRoot(r.data);
        else if (!r.ok) notifyFailure(r);
      } catch (err) {
        if (!isLatest()) return;
        notifyThrownError(err);
      } finally {
        releaseSelectDirectoryLock();
        busyRef.current = false;
        setBusy(false);
      }
    },
    [setRoot],
  );

  return { busy, selectFolder };
}
