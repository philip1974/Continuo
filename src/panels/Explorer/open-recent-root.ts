import { coApi } from '@/lib/co-api';
import { workspaceRootSelectionGuard } from '@/lib/workspace-root-guard';
import { focusWindowIfWorkspaceOpen } from '@/lib/focus-workspace-window';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';
import { focusWithinOrLost } from '@/design/focus-within-or-lost';
import { WORKBENCH_PART_ATTR } from '@/shell/focus-parts';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { requestExplorer } from './explorer-requests';

// race(R27,R18/R19 同族收口):改用全窗口共享的 workspaceRootSelectionGuard,使「打开最近」与
// drop / EmptyWorkspace 打开 / ExplorerHeader 切换 互相失效(全局 last-wins,见 guard 注释)。
// 连点最近目录 A→B 时,迟到的 A listDir 成功不得 setRoot(A) 覆盖后选的 B;且别的入口发起新选择
// 时本入口在途的探测同样作废。

/**
 * a11y(A147,A146/A141 同族):点击「最近打开」目录前先 listDir 探测可访问性。最近目录可能已被
 * 删除 / 移动 / 失去权限 —— 直接 setRoot 会切进一个空白 Explorer(FolderTree 的 dataLoader
 * listDir 失败默认仅 console.warn,无 onIpcWarn notify),用户(尤其键盘/屏幕阅读器)只看到
 * 切换「没反应」却不知 root 已失效。探测失败 → notify.error 且不切换;成功才 setRoot。
 *
 * race(R19):listDir 探测是异步,连点 A→B 时旧探测结果不得乱序覆盖新选择 → latest 守卫。
 */
// 目录已不存在(删除 / 移走)的错误码:VSCode 此时询问是否从「最近打开」列表删除,而不是只报错。
const MISSING_CODES: ReadonlySet<string> = new Set(['FS_NOT_FOUND', 'WORKSPACE_NOT_FOUND']);

export async function openRecentRootOrNotify(
  path: string,
  setRoot: (p: string) => void,
  /** 目录已不存在时调用(代替 toast;调用方询问是否从列表删除)。缺省则照常 toast。 */
  onMissing?: (p: string) => void,
): Promise<void> {
  const isLatest = workspaceRootSelectionGuard.begin();
  try {
    // perf:只看 ok(可访问性探测)→ withStats:false,main 不逐项 lstat。
    const r = await coApi.fs.listDir(path, { withStats: false });
    // 期间有更新的「打开最近」发起 → 本次过期,丢弃(不 setRoot 不报),由最新一次负责。
    if (!isLatest()) return;
    if (!r.ok) {
      if (onMissing !== undefined && MISSING_CODES.has(r.code)) onMissing(path);
      else notifyFailure(r);
      return;
    }
    await switchToCheckedRoot(path, isLatest, setRoot);
  } catch (err) {
    if (!isLatest()) return;
    notifyThrownError(err);
  }
}

/**
 * 已确认可打开的目录 → 切到它(最近打开 / 拖入文件夹共用):已在别的窗口打开 → 那个窗口已被聚焦,本窗口(含焦点)不变
 *(VSCode 同);期间有更新的选择 → 作废;否则 setRoot 并把焦点交给新 root 的文件树(focusTreeAfterRootSwitch)。
 */
export async function switchToCheckedRoot(
  path: string,
  isLatest: () => boolean,
  setRoot: (p: string) => void,
): Promise<void> {
  if (await focusWindowIfWorkspaceOpen(path)) return;
  if (!isLatest()) return;
  setRoot(path);
  focusTreeAfterRootSwitch();
}

/**
 * 本窗口切换 root 之后:焦点仍在侧栏里或已丢失(触发它的「更多操作」/ 空态最近项随 root 变化卸载,焦点会掉到 body)→
 * 交给新 root 的文件树(VSCode:切换文件夹后焦点在资源管理器;同「打开文件夹」的 focusTree 请求,树加载完再给)。焦点已被
 * 用户移到别处(编辑器 / 终端)→ 不抢(focusWithinOrLost)。最近打开 / 拖入文件夹共用。
 * BDD: src/__tests__/explorer-commands/(§4)
 */
export function focusTreeAfterRootSwitch(doc: Document = document): void {
  const root = useWorkspaceStore.getState().root;
  if (root === null) return;
  const sidebar = doc.querySelector(`[${WORKBENCH_PART_ATTR}="sidebar"]`);
  if (focusWithinOrLost(doc, sidebar)) requestExplorer({ kind: 'focusTree', root });
}
