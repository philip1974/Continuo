// 「弹原生目录选择器 → 切 workspace root」的共享流程(重构:EmptyWorkspace 的「打开文件夹」与
// ExplorerHeader 的「切换文件夹」此前逐行复制;R106 单飞闸门、R27 过期守卫、A146 失败反馈每次都要
// 两边同步)。「打开文件夹」命令(explorer-commands.ts)直接调 selectWorkspaceFolder。
//
//   - race(R106,R8 同族):busy 是异步 state,同 tick 双击/Enter 在 disabled 渲染前会发起多个
//     selectDirectory()。同步单飞闸门立即挡掉并发(全 app 同时只一个原生目录选择器,与
//     WindowPlugin「在新窗口打开文件夹」共享同一把锁)。
//   - race(R27):全窗口共享的 workspaceRootSelectionGuard,与 drop / 打开最近 互相失效。本次对话框
//     结果落地前若别的入口发起了新选择,则本次过期 → 不 setRoot、不报错。
//   - a11y(A146,A141 同族):取消(ok + 无 data)是正常 no-op;但 !r.ok / reject 须 notify,否则
//     控件退出 busy 却无 toast/live region 反馈,用户不知为何没切。

import { useCallback, useState } from 'react';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { coApi } from '@/lib/co-api';
import { workspaceRootSelectionGuard } from '@/lib/workspace-root-guard';
import {
  trySelectDirectoryLock,
  releaseSelectDirectoryLock,
} from '@/lib/select-directory-single-flight';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';
import { requestExplorer } from '../explorer-requests';

export interface SelectWorkspaceFolder {
  /** 选择器打开中(控件据此 disabled / aria-busy)。 */
  readonly busy: boolean;
  /**
   * 发起选择。`onStart` 在拿到单飞锁之后、弹对话框之前同步调用(ExplorerHeader 用它关菜单并
   * 还原焦点);被单飞锁挡掉时不调用。
   */
  readonly selectFolder: (onStart?: () => void) => Promise<void>;
}

export interface SelectWorkspaceFolderOptions {
  /** 拿到单飞锁之后、弹对话框之前同步调用;被单飞锁挡掉时不调用。 */
  readonly onStart?: () => void;
  /** 选择器打开中 / 结束(hook 的 busy state)。 */
  readonly setBusy?: (busy: boolean) => void;
  /** 选定并已切换 root 之后(打开文件夹命令据此显示侧栏)。 */
  readonly onSelected?: () => void;
}

/**
 * 弹目录选择器 → 切 workspace root(hook 与「打开文件夹」命令共用)。选定后把焦点交给新 root 的文件树(VSCode:打开
 * 文件夹后焦点在资源管理器),不随被卸载的空态按钮掉到 body。
 */
export async function selectWorkspaceFolder(opts: SelectWorkspaceFolderOptions = {}): Promise<void> {
  // 全局单飞锁同时挡住本实例的重入(持锁期间再次调用同样拿不到锁)。
  if (!trySelectDirectoryLock()) return;
  opts.onStart?.();
  opts.setBusy?.(true);
  const isLatest = workspaceRootSelectionGuard.begin();
  try {
    const r = await coApi.fs.selectDirectory();
    if (!isLatest()) return;
    if (r.ok && r.data) {
      const { setRoot } = useWorkspaceStore.getState();
      setRoot(r.data);
      opts.onSelected?.();
      const root = useWorkspaceStore.getState().root;
      if (root) requestExplorer({ kind: 'focusTree', root });
    } else if (!r.ok) notifyFailure(r);
  } catch (err) {
    if (!isLatest()) return;
    notifyThrownError(err);
  } finally {
    releaseSelectDirectoryLock();
    opts.setBusy?.(false);
  }
}

export function useSelectWorkspaceFolder(): SelectWorkspaceFolder {
  const [busy, setBusy] = useState(false);

  const selectFolder = useCallback(
    (onStart?: () => void): Promise<void> => selectWorkspaceFolder({ onStart, setBusy }),
    [],
  );

  return { busy, selectFolder };
}
