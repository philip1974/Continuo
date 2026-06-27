// 新建 user terminal 的共用流程(可维护性 M1:消除平行实现)。
//
// 命令面板 `terminal.new`(core-plugins/TerminalPlugin)与 Dock header「新建终端」
// 入口(shell/dock/HeaderActions)此前各自手写了同一段创建流程,HeaderActions 注释也
// 明写「同 TerminalPlugin.terminal.new」。平行实现易在改动终端创建契约时只改一处而漂移。
// 抽到此处单一来源;调用方只负责各自的 UI 收尾(如关闭菜单)。

import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import {
  useWorkspaceStore,
  waitForWorkspaceHydrated,
} from '@/stores/workspace.store';
import { preloadTerminalPanelChunk } from '@/lib/terminal-chunk-warmup';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { t } from '@/i18n';

/**
 * 新建一个 user terminal,返回新 terminal id(失败返 null)。
 *
 * 流程:
 *  1. 等 workspace hydrate 完成 —— 冷启动竞态:hydrate 未完成时 root 仍是初始 null →
 *     terminal.create 不带 cwd → main 抛 TERMINAL_CWD_UNRESOLVED,首次新建失败不重试。
 *     (workspace.store hydrated 契约 + stores/README 要求消费方等待。codex 复审 loop R10)
 *  2. 读 workspace root 当 cwd / workspaceRoot。
 *  3. coApi.terminal.create(originHint 'user')。
 *  4. 失败 → notify.error(区分 CWD_UNRESOLVED 与通用),返 null。
 *  5. 成功 → setPendingFocus(让 SessionsSync/DockReconciler 聚焦新建 panel),返 id。
 *
 * UI 收尾(关闭菜单等)由调用方自理。
 */
export async function createUserTerminal(): Promise<string | null> {
  // 性能(Phase-5 终端新建加载):用户点了「新建终端」= 明确 intent。立即 fire-and-forget
  // 预取 6MB+ xterm 面板 chunk,使其下载/解析与下面的 hydrate 等待 + IPC create + PTY
  // spawn + shell 启动**并行**;否则首个终端要等 session push 后 React.lazy 才开始拉
  // chunk(无提前量),把冷 chunk 加载推到用户可见的首屏 ready 路径上。重复调用经模块
  // 缓存去重,无副作用。见 [[terminal-chunk-warmup]]。
  preloadTerminalPanelChunk();
  await waitForWorkspaceHydrated();
  const workspaceRoot = useWorkspaceStore.getState().root ?? undefined;
  // a11y(A116,A50/A115 同族):整体 try/catch —— coApi.terminal.create 只返 {ok:false} 处理
  // 业务失败,但 IPC promise reject 会直接抛;调用点(HeaderActions onClick void addPanel)
  // 不 await/catch → 用户点「新建终端」无反馈、菜单不关。reject 也走 create_failed notify。
  try {
    const r = await coApi.terminal.create({
      originHint: 'user',
      ...(workspaceRoot !== undefined ? { cwd: workspaceRoot, workspaceRoot } : {}),
    });
    if (!r.ok) {
      const msg =
        r.code === ERROR_CODES.TERMINAL_CWD_UNRESOLVED
          ? t('errors.terminal.cwd_unresolved')
          : t('errors.terminal.create_failed', { code: r.code ?? '?' });
      notify.error(msg, { code: r.code });
      return null;
    }
    if (!r.data?.id) return null;
    const { setPendingFocus } = await import('@/shell/dock/DockReconciler');
    setPendingFocus(r.data.id);
    return r.data.id;
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'EXCEPTION';
    // race(R31):用户在 create 期间关掉了刚开的 tab → main 复查 reservation 已取消、kill 了孤儿
    // PTY 并以 TERMINAL_CREATE_CANCELLED 收场。这是用户主动行为,不是失败,静默 no-op 不弹错误。
    if (code === ERROR_CODES.TERMINAL_CREATE_CANCELLED) return null;
    notify.error(t('errors.terminal.create_failed', { code }), { code });
    return null;
  }
}
