// 新建 user terminal 的共用流程(可维护性 M1:消除平行实现)。
//
// 命令面板 `terminal.new`(core-plugins/TerminalPlugin)、Dock header「新建终端」
// 入口(shell/dock/HeaderActions)与 Explorer「在终端中打开」此前各自手写了同一段创建流程,HeaderActions 注释也
// 明写「同 TerminalPlugin.terminal.new」。平行实现易在改动终端创建契约时只改一处而漂移。
// 抽到此处单一来源;调用方只负责各自的 UI 收尾(如关闭菜单)。

import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import {
  useWorkspaceStore,
  waitForWorkspaceRootRestored,
} from '@/stores/workspace.store';
import { preloadTerminalPanelChunk } from '@/lib/terminal-chunk-warmup';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { t } from '@/i18n';
import { setPendingFocus } from './DockReconciler';
import { errorCodeOf } from '../../../electron/shared/error-message';
import { coApp } from '@/plugins/co-app';
import { runRegisteredCommand } from '@/lib/run-contributed-action';
import { OPEN_FOLDER_COMMAND } from '@/panels/Explorer/explorer-commands';

/**
 * 新终端的 COLORFGBG(「前景;背景」ANSI 色号):让 P10k 等 prompt 框架启动时检测到当前主题亮度。读 <html> 的 .dark
 *(ThemeProvider 的切换结果)。已在跑的 PTY 不会因主题切换而重渲。所有新建入口经此统一带上(此前只有 Explorer
 *「在终端中打开」传,Cmd+T / Dock 头部新建在浅色主题下拿不到背景亮度)。
 */
export function terminalColorFgBg(): string {
  // 无 DOM(非 renderer 环境)按默认暗色主题。
  const dark = typeof document === 'undefined' || document.documentElement.classList.contains('dark');
  return dark ? '15;0' : '0;15';
}

/**
 * 新建一个 user terminal,返回新 terminal id(失败返 null)。
 *
 * 流程:
 *  1. 等 workspace root 恢复 —— 冷启动竞态:恢复前 root 仍是初始 null →
 *     terminal.create 不带 cwd → main 抛 TERMINAL_CWD_UNRESOLVED,首次新建失败不重试。
 *     (复审 loop R10)只需 root:等 rootRestored 而非 hydrated,不被编辑器 tab 恢复读盘拖住。
 *  2. 读 workspace root 当 workspaceRoot;cwd 缺省也取它(Explorer 入口传所选目录)。
 *  3. coApi.terminal.create(originHint 'user')。
 *  4. 失败 → 返 null。无工作区(未传 cwd 的 CWD_UNRESOLVED)不是错误:直接调起「打开文件夹」命令并等它完成(保留用户
 *     意图):选定文件夹 → 在新 root 重新走本流程新建终端;取消 → notify.info「请先打开一个文件夹」(notify 不能撤掉,
 *     故不先弹,免得选定后提示还挂着;Continuo 刻意不回退主目录)。其余失败 notify.error。
 *  5. 成功 → setPendingFocus(让 SessionsSync/DockReconciler 聚焦新建 panel),返 id。
 *
 * UI 收尾(关闭菜单等)由调用方自理。
 */

export async function createUserTerminal(
  opts: { readonly cwd?: string } = {},
): Promise<string | null> {
  // 性能(Phase-5 终端新建加载):用户点了「新建终端」= 明确 intent。立即 fire-and-forget
  // 预取 6MB+ xterm 面板 chunk,使其下载/解析与下面的 root 恢复等待 + IPC create + PTY
  // spawn + shell 启动**并行**;否则首个终端要等 session push 后 React.lazy 才开始拉
  // chunk(无提前量),把冷 chunk 加载推到用户可见的首屏 ready 路径上。重复调用经模块
  // 缓存去重,无副作用。见 [[terminal-chunk-warmup]]。
  preloadTerminalPanelChunk();
  // 性能(冷启动关键路径):只读 root,不等 hydrated(其在编辑器 tab 并发读盘完成后才置位)。
  await waitForWorkspaceRootRestored();
  const workspaceRoot = useWorkspaceStore.getState().root ?? undefined;
  // a11y(A116,A50/A115 同族):整体 try/catch —— coApi.terminal.create 只返 {ok:false} 处理
  // 业务失败,但 IPC promise reject 会直接抛;调用点(HeaderActions onClick void addPanel)
  // 不 await/catch → 用户点「新建终端」无反馈、菜单不关。reject 也走 create_failed notify。
  try {
    const cwd = opts.cwd ?? workspaceRoot;
    const r = await coApi.terminal.create({
      originHint: 'user',
      ...(cwd !== undefined ? { cwd } : {}),
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      env: { COLORFGBG: terminalColorFgBg() },
    });
    if (!r.ok) {
      // 退出闸(终审 P1):退出清理开始后 main 以 CANCELLED 拒绝新建;窗口已隐藏,静默即可(同下方 catch)。
      if (r.code === ERROR_CODES.TERMINAL_CREATE_CANCELLED) return null;
      // main 对「未传 cwd」与「cwd 不存在 / 不是目录」同返 CWD_UNRESOLVED:传了 cwd(workspace root 被外部删除 / 改名 /
      // 外置盘断开,或 Explorer「在终端中打开」已删目录)时不能提示「先打开文件夹」。
      if (r.code === ERROR_CODES.TERMINAL_CWD_UNRESOLVED && cwd === undefined) {
        // 无工作区:引导而非报错(VSCode 心智:缺前置条件时直接给出下一步,完成后接着做原来的事)—— 弹出「打开文件夹」
        // 对话框(与 ⌘O / 资源管理器「打开文件夹」同一命令)并等它完成。BDD: src/__tests__/create-user-terminal/
        await runRegisteredCommand(coApp.commands, OPEN_FOLDER_COMMAND.id, t('commands.file.open_folder.title'));
        // 选定了文件夹 → 在新 root 新建(此时 root 已有值,不会再走到这里)
        if (useWorkspaceStore.getState().root) return await createUserTerminal(opts);
        // 取消(或对话框已被别处占用):不建终端,说明原因
        notify.info(t('errors.terminal.cwd_unresolved'), { code: r.code });
        return null;
      }
      const msg =
        r.code === ERROR_CODES.TERMINAL_CWD_UNRESOLVED
          ? t('errors.terminal.cwd_missing', { path: cwd ?? '' })
          : t('errors.terminal.create_failed', { code: r.code ?? '?' });
      notify.error(msg, { code: r.code });
      return null;
    }
    if (!r.data?.id) return null;
    setPendingFocus(r.data.id);
    return r.data.id;
  } catch (err) {
    const code = errorCodeOf(err);
    // race(R31):用户在 create 期间关掉了刚开的 tab → main 复查 reservation 已取消、kill 了孤儿
    // PTY 并以 TERMINAL_CREATE_CANCELLED 收场。这是用户主动行为,不是失败,静默 no-op 不弹错误。
    if (code === ERROR_CODES.TERMINAL_CREATE_CANCELLED) return null;
    notify.error(t('errors.terminal.create_failed', { code }), { code });
    return null;
  }
}
