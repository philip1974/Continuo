import { useState } from 'react';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { Button } from '@/design';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { localizeErrorByCode } from '@/lib/localize-error';
import { openRecentRootOrNotify } from './open-recent-root';
import { workspaceRootSelectionGuard } from '@/lib/workspace-root-guard';
import {
  trySelectDirectoryLock,
  releaseSelectDirectoryLock,
} from '@/lib/select-directory-single-flight';
import { useT } from '@/i18n';
import { SR_ONLY_STYLE } from '@/lib/sr-only';

// 未选 workspace 时占位:中央"打开文件夹"按钮(VSCode 风)。
// 调 fs.selectDirectory(原生对话框)→ setRoot,store 一变 Explorer 容器自动切到 FolderTree。
export function EmptyWorkspace() {
  const setRoot = useWorkspaceStore((s) => s.setRoot);
  const recentRoots = useWorkspaceStore((s) => s.recentRoots);
  const [busy, setBusy] = useState(false);
  const t = useT();

  const open = async () => {
    if (busy) return;
    // race(R106,R8 同族):busy 是异步 state,同 tick 双击/Enter 在 disabled 渲染前会发起多个
    // selectDirectory()。同步单飞闸门立即挡掉并发(全 app 同时只一个原生目录选择器)。
    if (!trySelectDirectoryLock()) return;
    setBusy(true);
    // race(R27):全窗口共享守卫,与 drop / 打开最近 / ExplorerHeader 切换 互相失效。本次对话框
    // 结果落地前若别的入口发起新选择(或本组件 busy 之外的并发路径),则本次过期 → 不 setRoot/不报。
    const isLatest = workspaceRootSelectionGuard.begin();
    try {
      const r = await coApi.fs.selectDirectory();
      if (!isLatest()) return;
      // a11y(A146,A141 同族):取消(ok+无 data)是正常 no-op;但 !r.ok / reject 此前静默 →
      // 打开文件夹失败时按钮退出 busy 却无 toast/live region 反馈,用户不知为何没切。
      if (r.ok && r.data) setRoot(r.data);
      else if (!r.ok)
        notify.error(localizeErrorByCode(r.code, r.message), { code: r.code });
    } catch (err) {
      if (!isLatest()) return;
      const code = (err as { code?: string })?.code ?? 'EXCEPTION';
      notify.error(localizeErrorByCode(code, (err as Error)?.message ?? code), { code });
    } finally {
      releaseSelectDirectoryLock();
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center text-sm text-fg-muted">
      <div className="text-xs uppercase tracking-wider text-fg-dim">
        {t('panels.explorer.empty.no_folder')}
      </div>
      <Button
        variant="outlined"
        size="md"
        onClick={open}
        disabled={busy}
        // a11y(A96,A93 同族):打开系统目录选择器进行中标 aria-busy(忙碌语义)。
        aria-busy={busy}
      >
        {busy
          ? t('panels.explorer.empty.opening')
          : t('panels.explorer.empty.open_folder')}
      </Button>
      {/* a11y(A96,A51 同族):opening 瞬时态焦点在按钮/原生对话框切换时反馈不稳 →
          视觉隐藏 role=status 镜像「打开中」(仅 busy 时输出)。 */}
      <span style={SR_ONLY_STYLE} role="status">
        {busy ? t('panels.explorer.empty.opening') : ''}
      </span>
      {recentRoots.length > 0 && (
        <div className="mt-4 w-full max-w-xs text-left">
          <div className="px-3 pb-1 text-2xs uppercase tracking-wider text-fg-dim">
            {t('panels.explorer.empty.recent')}
          </div>
          {/* a11y(A19):最近目录是常驻列表,不是弹出菜单 → 用 ul/li + 普通 button(role=
              button),不用 role=menu/MenuItem(role=menuitem) —— 后者会让 AT 误读成应用菜单,
              且 menuitem 脱离 menu 父级本就是非法 ARIA。行项用 design Button ghost(左对齐
              全宽),保持视觉一致又恢复正确语义。 */}
          <ul aria-label={t('panels.explorer.empty.recent')}>
            {recentRoots.map((p) => {
              const m = p.match(/[^/\\]+$/);
              const name = m ? m[0] : p;
              const parent = m ? p.slice(0, p.length - m[0].length).replace(/[/\\]$/, '') : '';
              return (
                <li key={p}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => void openRecentRootOrNotify(p, setRoot)}
                    title={p}
                    // a11y(A80,A78 同族):可见 basename/parent 可截断且同名不可区分 → aria-label
                    // 注入完整路径(复用 A78 recent 项 key)。
                    aria-label={t('panels.explorer.menu.open_recent_item_aria', {
                      path: p,
                    })}
                  >
                    <span className="flex items-baseline gap-2 min-w-0">
                      <span className="truncate font-medium">{name}</span>
                      {parent && (
                        <span className="truncate text-2xs text-fg-dim">{parent}</span>
                      )}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
