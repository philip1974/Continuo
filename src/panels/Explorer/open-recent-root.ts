import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { localizeErrorByCode } from '@/lib/localize-error';
import { workspaceRootSelectionGuard } from '@/lib/workspace-root-guard';

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
export async function openRecentRootOrNotify(
  path: string,
  setRoot: (p: string) => void,
): Promise<void> {
  const isLatest = workspaceRootSelectionGuard.begin();
  try {
    const r = await coApi.fs.listDir(path);
    // 期间有更新的「打开最近」发起 → 本次过期,丢弃(不 setRoot 不报),由最新一次负责。
    if (!isLatest()) return;
    if (!r.ok) {
      notify.error(localizeErrorByCode(r.code, r.message), { code: r.code });
      return;
    }
    setRoot(path);
  } catch (err) {
    if (!isLatest()) return;
    const code = (err as { code?: string })?.code ?? 'EXCEPTION';
    notify.error(localizeErrorByCode(code, (err as Error)?.message ?? code), { code });
  }
}
