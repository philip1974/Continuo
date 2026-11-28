// 主窗异常(渲染进程崩溃 / 无响应)的原生提示与恢复。对齐 VSCode CodeWindow.onWindowError
// (src/vs/platform/windows/electron-main/windowImpl.ts):
//   - render-process-gone → 「窗口意外终止(原因 / 代码)」+「重新打开」「关闭」;
//   - unresponsive → 「窗口没有响应」+「重新打开」「关闭」「保持等待」;开了 DevTools 时不弹(断点停住也会报无响应)。
// 刻意差异:
//   - 重新打开 = 在同一窗口里 reload(VSCode 销毁窗口再按工作区开新窗;这里 reload 后 renderer 按本窗 windowSeq 段恢复布局);
//   - 崩溃前有未保存的 tab → 框里列出这些文件并说明改动已丢失(只提示;VSCode 有热退出备份,这里没有);
//   - 无响应框选重新打开 / 关闭:先 forcefullyCrashRenderer,等杀进程引发的 render-process-gone 到达后再走与崩溃框
//     同一条恢复路径(同 tick 立即 reload 会被正在退出的旧进程吞掉,窗口停在崩溃空白态);超时没等到 gone 也照样恢复
//     (VSCode 直接 destroy 窗口再开新窗,没有这段时序);
//   - 恢复响应(responsive)时用 AbortSignal 关掉仍开着的「无响应」框(VSCode 留着框,用户点了才处理);
//   - 无 VSCode 的「不恢复编辑器」复选框。
// dockview popout 子窗与主窗同一渲染进程、内容由主窗 renderer 驱动:主窗崩溃后它们只剩空壳 → 重新打开 / 关闭时一并销毁
//(面板由主窗布局恢复重新弹出)。子窗自己的 render-process-gone 不弹框(VSCode 辅助窗口同样不处理),崩溃提示只由主窗弹一次。
// electron 依赖由调用方注入(可单测),见 src/__tests__/window-crash-recovery/。

import type { MainT } from './i18n';
import { DIRTY_CLOSE_MAX_NAMES, dirtyIdFileName } from './dirty-close-confirm';
import type { DirtyState } from '../shared/persistence-channels';

export interface RenderProcessGoneInfo {
  readonly reason: string;
  readonly exitCode?: number;
}

export interface WindowErrorDialogOptions {
  readonly type: 'warning';
  readonly buttons: string[];
  readonly defaultId: number;
  readonly cancelId: number;
  readonly noLink: true;
  readonly message: string;
  readonly detail: string;
  readonly signal?: AbortSignal;
}

/** 按钮下标(两种框共用前两个)。 */
export const REOPEN_ID = 0;
export const CLOSE_ID = 1;
export const KEEP_WAITING_ID = 2;
/** 无响应框选了重新打开 / 关闭、杀掉 renderer 后最多等 render-process-gone 这么久,超时照样恢复。 */
export const KILL_GONE_TIMEOUT_MS = 3000;

export function buildCrashDialog(
  info: RenderProcessGoneInfo,
  lost: DirtyState | undefined,
  t: MainT,
): WindowErrorDialogOptions {
  const lines = [t('dialog.window_crashed.detail')];
  if (lost && lost.ids.length > 0) {
    const names = lost.ids.slice(0, DIRTY_CLOSE_MAX_NAMES).map((id) => dirtyIdFileName(id, t));
    const more = lost.ids.length - names.length;
    if (more > 0) {
      names.push(t(more === 1 ? 'dialog.unsaved_close.more_one' : 'dialog.unsaved_close.more_other', { count: more }));
    }
    lines.push('', t('dialog.window_crashed.lost_files'), ...names);
  }
  return {
    type: 'warning',
    buttons: [t('dialog.window_error.reopen'), t('dialog.window_error.close')],
    defaultId: REOPEN_ID,
    cancelId: CLOSE_ID,
    noLink: true,
    message: t('dialog.window_crashed.message', {
      reason: info.reason,
      code: info.exitCode === undefined ? '<unknown>' : String(info.exitCode),
    }),
    detail: lines.join('\n'),
  };
}

export function buildUnresponsiveDialog(t: MainT): WindowErrorDialogOptions {
  return {
    type: 'warning',
    buttons: [
      t('dialog.window_error.reopen'),
      t('dialog.window_error.close'),
      t('dialog.window_error.keep_waiting'),
    ],
    defaultId: REOPEN_ID,
    // Esc / 被 signal 关掉 = 继续等待。
    cancelId: KEEP_WAITING_ID,
    noLink: true,
    message: t('dialog.window_unresponsive.message'),
    detail: t('dialog.window_unresponsive.detail'),
  };
}

/** BrowserWindow 中本模块用到的部分。 */
export interface WindowErrorTarget {
  isDestroyed(): boolean;
  on(event: 'unresponsive' | 'responsive', listener: () => void): unknown;
  readonly webContents: {
    on(event: 'render-process-gone', listener: (event: unknown, details: RenderProcessGoneInfo | undefined) => void): unknown;
    isDestroyed(): boolean;
    isDevToolsOpened(): boolean;
    forcefullyCrashRenderer(): void;
    reload(): void;
  };
}

export interface WindowErrorDeps {
  readonly t: () => MainT;
  readonly showMessageBox: (opts: WindowErrorDialogOptions) => Promise<{ response: number }>;
  /** 该窗口当前记账的脏 tab(崩溃事件到达时同步读取 —— 须先于清理脏态的监听)。 */
  readonly dirtySnapshot: () => DirtyState | undefined;
  /** 销毁该窗口打开的 popout 子窗(含子窗再弹出的)。 */
  readonly destroyPopouts: () => void;
  /** 关闭窗口(未保存改动已丢失:调用方先丢弃脏态记账,不再弹「是否保存」)。 */
  readonly close: () => void;
  /** 应用退出中,或该窗口已在关闭流程里(关窗 flush 在途时崩溃:窗口随后照常关掉,不弹框)。 */
  readonly isClosing: () => boolean;
}

/** 给主窗挂崩溃 / 无响应处理。须在清理脏态的 render-process-gone 监听(wireWindowCloseFlush)之前调用。 */
export function wireWindowErrorDialogs(win: WindowErrorTarget, deps: WindowErrorDeps): void {
  let crashDialogOpen = false;
  /**
   * 「无响应」框选了重新打开 / 关闭后主动杀掉 renderer:记下选择,随之而来的 render-process-gone 不再弹崩溃框,
   * 而是按这个选择恢复(或超时兜底)。
   */
  let pendingKill: { readonly response: number; readonly timer: ReturnType<typeof setTimeout> } | null = null;
  let unresponsive: AbortController | null = null;

  const recover = (response: number): void => {
    if (win.isDestroyed()) return;
    deps.destroyPopouts();
    if (response === REOPEN_ID) {
      if (!win.webContents.isDestroyed()) win.webContents.reload();
    } else {
      deps.close();
    }
  };

  win.webContents.on('render-process-gone', (_event, details) => {
    const lost = deps.dirtySnapshot();
    unresponsive?.abort();
    unresponsive = null;
    if (pendingKill) {
      const { response, timer } = pendingKill;
      pendingKill = null;
      clearTimeout(timer);
      recover(response);
      return;
    }
    const info = details ?? { reason: 'unknown' };
    if (info.reason === 'clean-exit' || crashDialogOpen || deps.isClosing() || win.isDestroyed()) return;
    crashDialogOpen = true;
    deps
      .showMessageBox(buildCrashDialog(info, lost, deps.t()))
      // 弹框失败:窗口已是空壳,按重新打开处理。
      .catch((err: unknown) => {
        console.warn('[window-error] crash dialog failed', err);
        return { response: REOPEN_ID };
      })
      .then(({ response }) => {
        crashDialogOpen = false;
        recover(response);
      });
  });

  win.on('unresponsive', () => {
    if (unresponsive || pendingKill || crashDialogOpen || deps.isClosing() || win.isDestroyed()) return;
    if (win.webContents.isDestroyed() || win.webContents.isDevToolsOpened()) return;
    const controller = new AbortController();
    unresponsive = controller;
    deps
      .showMessageBox({ ...buildUnresponsiveDialog(deps.t()), signal: controller.signal })
      .catch((err: unknown) => {
        console.warn('[window-error] unresponsive dialog failed', err);
        return { response: KEEP_WAITING_ID };
      })
      .then(({ response }) => {
        if (unresponsive === controller) unresponsive = null;
        if (controller.signal.aborted || response === KEEP_WAITING_ID || win.isDestroyed()) return;
        if (pendingKill) return;
        if (win.webContents.isDestroyed()) {
          recover(response);
          return;
        }
        // 杀掉卡死的 renderer,等 render-process-gone 再恢复(见文件头);超时没等到也恢复。
        const timer = setTimeout(() => {
          if (pendingKill?.timer !== timer) return;
          pendingKill = null;
          recover(response);
        }, KILL_GONE_TIMEOUT_MS);
        pendingKill = { response, timer };
        win.webContents.forcefullyCrashRenderer();
      });
  });

  win.on('responsive', () => {
    unresponsive?.abort();
    unresponsive = null;
  });
}

/**
 * 某 webContents(主窗)打开的全部 popout 子窗,含子窗再弹出的(传递闭包)。openerOf:子窗 → 打开它的 webContents id。
 */
export function popoutsOpenedBy<W extends { readonly webContentsId: number | null }>(
  rootWebContentsId: number,
  windows: readonly W[],
  openerOf: (w: W) => number | undefined,
): W[] {
  const openers = new Set([rootWebContentsId]);
  const found: W[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const w of windows) {
      if (found.includes(w)) continue;
      const opener = openerOf(w);
      if (opener === undefined || !openers.has(opener)) continue;
      found.push(w);
      if (w.webContentsId !== null) openers.add(w.webContentsId);
      grew = true;
    }
  }
  return found;
}
