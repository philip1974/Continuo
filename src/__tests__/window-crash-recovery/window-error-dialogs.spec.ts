// BDD: window-crash-recovery / 主窗渲染进程崩溃、无响应的原生提示与恢复(electron 以 EventEmitter 替身驱动)。见同目录 README.md。
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  CLOSE_ID,
  KEEP_WAITING_ID,
  KILL_GONE_TIMEOUT_MS,
  REOPEN_ID,
  buildCrashDialog,
  popoutsOpenedBy,
  wireWindowErrorDialogs,
  type WindowErrorDialogOptions,
} from '../../../electron/main/window-error-dialogs';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';
import { interpolateTemplate } from '../../../electron/shared/i18n-interpolate';
import type { DirtyState } from '../../../electron/shared/persistence-channels';
import { flushMicrotasks } from '../_helpers/async';

const t = (key: string, params?: Record<string, string | number>) => {
  const tpl = (en as Record<string, string>)[key] ?? key;
  return params ? interpolateTemplate(tpl, params) : tpl;
};

function makeWindow() {
  const win = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    isDestroyed(): boolean;
    webContents: EventEmitter & {
      isDestroyed(): boolean;
      isDevToolsOpened: ReturnType<typeof vi.fn>;
      forcefullyCrashRenderer: ReturnType<typeof vi.fn>;
      reload: ReturnType<typeof vi.fn>;
    };
  };
  win.destroyed = false;
  win.isDestroyed = () => win.destroyed;
  const wc = new EventEmitter() as typeof win.webContents;
  wc.isDestroyed = () => win.destroyed;
  wc.isDevToolsOpened = vi.fn(() => false);
  wc.reload = vi.fn();
  // 真实 Electron:杀掉 renderer 后异步发 render-process-gone(reason killed)。
  wc.forcefullyCrashRenderer = vi.fn(() => {
    queueMicrotask(() => wc.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 }));
  });
  win.webContents = wc;
  return win;
}

function setup(dirty?: DirtyState) {
  const win = makeWindow();
  let pending: Array<{ opts: WindowErrorDialogOptions; resolve: (r: { response: number }) => void }> = [];
  let dirtyState = dirty;
  const deps = {
    t: () => t,
    showMessageBox: vi.fn(
      (opts: WindowErrorDialogOptions) =>
        new Promise<{ response: number }>((resolve) => {
          const entry = { opts, resolve };
          pending.push(entry);
          // Electron:signal 触发 → 框关闭,按 cancelId 应答。
          opts.signal?.addEventListener('abort', () => resolve({ response: opts.cancelId }));
        }),
    ),
    dirtySnapshot: vi.fn(() => dirtyState),
    destroyPopouts: vi.fn(),
    close: vi.fn(),
    isClosing: vi.fn(() => false),
  };
  wireWindowErrorDialogs(win, deps);
  // 模拟 wireWindowCloseFlush:崩溃时随后清掉脏态记账(本模块的监听须先于它取快照)。
  win.webContents.on('render-process-gone', () => {
    dirtyState = undefined;
  });
  const answer = async (response: number) => {
    const entry = pending.shift();
    expect(entry, 'dialog shown').toBeDefined();
    entry!.resolve({ response });
    await flushMicrotasks();
  };
  return { win, deps, answer, dialogs: () => deps.showMessageBox.mock.calls.map((c) => c[0]), reset: () => (pending = []) };
}

const crash = (win: ReturnType<typeof makeWindow>, reason = 'crashed', exitCode = 5) =>
  win.webContents.emit('render-process-gone', {}, { reason, exitCode });

describe('渲染进程崩溃', () => {
  it('弹「窗口意外终止(原因 / 代码)」+ 重新打开 / 关闭', () => {
    const { win, dialogs } = setup();
    crash(win, 'oom', 7);
    expect(dialogs()).toHaveLength(1);
    const opts = dialogs()[0]!;
    expect(opts.type).toBe('warning');
    expect(opts.message).toBe('The window terminated unexpectedly (reason: “oom”, code: “7”)');
    expect(opts.detail).toContain('reopen the window to continue where you left off');
    expect(opts.buttons).toEqual(['Reopen', 'Close']);
    expect(opts.defaultId).toBe(REOPEN_ID);
  });

  it('崩溃前有未保存的 tab → 列出文件名并说明更改已丢失(快照先于脏态清理)', () => {
    const { win, dialogs } = setup({ dirty: 2, ids: ['/w/src/a.ts#1', '/w/b.md#3'] });
    crash(win);
    const detail = dialogs()[0]!.detail;
    expect(detail).toContain('Unsaved changes to the following files were lost:');
    expect(detail).toContain('a.ts');
    expect(detail).toContain('b.md');
    expect(detail).not.toContain('/w/src');
  });

  it('超过 10 个文件只列前 10 个,其余一行概括', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `/w/f${i}.ts#1`);
    const detail = buildCrashDialog({ reason: 'crashed', exitCode: 1 }, { dirty: 12, ids }, t).detail;
    expect(detail).toContain('f9.ts');
    expect(detail).not.toContain('f10.ts');
    expect(detail).toContain('...2 additional files not shown');
  });

  it('没有脏 tab → 不提丢失', () => {
    const { win, dialogs } = setup();
    crash(win);
    expect(dialogs()[0]!.detail).not.toContain('lost');
  });

  it('同一次崩溃只弹一次(框开着时重复事件不叠框)', () => {
    const { win, dialogs } = setup();
    crash(win);
    crash(win);
    expect(dialogs()).toHaveLength(1);
  });

  it('「重新打开」→ 先销毁 popout 子窗,再 reload', async () => {
    const { win, deps, answer } = setup();
    crash(win);
    await answer(REOPEN_ID);
    expect(deps.destroyPopouts).toHaveBeenCalledTimes(1);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    expect(deps.destroyPopouts.mock.invocationCallOrder[0]!).toBeLessThan(
      win.webContents.reload.mock.invocationCallOrder[0]!,
    );
    expect(deps.close).not.toHaveBeenCalled();
  });

  it('「关闭」→ 销毁 popout 后关窗,不 reload', async () => {
    const { win, deps, answer } = setup();
    crash(win);
    await answer(CLOSE_ID);
    expect(deps.destroyPopouts).toHaveBeenCalledTimes(1);
    expect(deps.close).toHaveBeenCalledTimes(1);
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it('处理完后再次崩溃会再弹', async () => {
    const { win, answer, dialogs } = setup();
    crash(win);
    await answer(REOPEN_ID);
    crash(win);
    expect(dialogs()).toHaveLength(2);
  });

  it('clean-exit / 退出中 / 窗口已销毁 → 不弹', () => {
    const { win, deps, dialogs } = setup();
    crash(win, 'clean-exit', 0);
    deps.isClosing.mockReturnValue(true);
    crash(win);
    deps.isClosing.mockReturnValue(false);
    win.destroyed = true;
    crash(win);
    expect(dialogs()).toHaveLength(0);
  });
});

describe('窗口无响应', () => {
  it('弹「窗口没有响应」+ 重新打开 / 关闭 / 保持等待(Esc = 保持等待)', () => {
    const { win, dialogs } = setup();
    win.emit('unresponsive');
    const opts = dialogs()[0]!;
    expect(opts.message).toBe('The window is not responding');
    expect(opts.detail).toBe('You can reopen or close the window or keep waiting.');
    expect(opts.buttons).toEqual(['Reopen', 'Close', 'Keep Waiting']);
    expect(opts.cancelId).toBe(KEEP_WAITING_ID);
  });

  it('同一段无响应期间不重复弹框;恢复响应 → 关掉框且不做任何处理', async () => {
    const { win, deps, dialogs } = setup();
    win.emit('unresponsive');
    win.emit('unresponsive');
    expect(dialogs()).toHaveLength(1);
    const signal = dialogs()[0]!.signal!;
    win.emit('responsive');
    await flushMicrotasks();
    expect(signal.aborted).toBe(true);
    expect(win.webContents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    expect(deps.destroyPopouts).not.toHaveBeenCalled();
    // 下一次无响应重新弹
    win.emit('unresponsive');
    expect(dialogs()).toHaveLength(2);
  });

  it('「重新打开」→ 杀掉 renderer、销毁 popout、reload;随后的崩溃事件不再弹崩溃框', async () => {
    const { win, deps, answer, dialogs } = setup();
    win.emit('unresponsive');
    await answer(REOPEN_ID);
    expect(win.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    expect(deps.destroyPopouts).toHaveBeenCalledTimes(1);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    await flushMicrotasks(); // 杀进程引发的 render-process-gone
    expect(dialogs()).toHaveLength(1);
  });

  it('「重新打开」→ 等杀进程引发的 render-process-gone 到达后才 reload(同 tick reload 会被退出中的旧进程吞掉)', async () => {
    const { win, deps, answer, dialogs } = setup();
    win.webContents.forcefullyCrashRenderer.mockImplementation(() => {}); // gone 稍后才到
    win.emit('unresponsive');
    await answer(REOPEN_ID);
    expect(win.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    expect(win.webContents.reload).not.toHaveBeenCalled();
    expect(deps.destroyPopouts).not.toHaveBeenCalled();
    crash(win, 'killed', 9);
    expect(deps.destroyPopouts).toHaveBeenCalledTimes(1);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    expect(dialogs()).toHaveLength(1); // 不弹崩溃框
    // 之后真正的崩溃照常弹框
    crash(win);
    expect(dialogs()).toHaveLength(2);
  });

  it('杀掉 renderer 后迟迟收不到 render-process-gone → 超时兜底照样恢复,且只恢复一次', async () => {
    vi.useFakeTimers();
    try {
      const { win, deps, answer } = setup();
      win.webContents.forcefullyCrashRenderer.mockImplementation(() => {});
      win.emit('unresponsive');
      await answer(CLOSE_ID);
      vi.advanceTimersByTime(KILL_GONE_TIMEOUT_MS - 1);
      expect(deps.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(deps.close).toHaveBeenCalledTimes(1);
      crash(win, 'killed', 9); // 迟到的 gone:按普通崩溃处理(窗口已在关闭由 isClosing 拦;这里只验不重复恢复)
      expect(deps.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('「关闭」→ 杀掉 renderer 后关窗', async () => {
    const { win, deps, answer } = setup();
    win.emit('unresponsive');
    await answer(CLOSE_ID);
    expect(win.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    expect(deps.close).toHaveBeenCalledTimes(1);
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it('「保持等待」→ 什么都不做', async () => {
    const { win, deps, answer } = setup();
    win.emit('unresponsive');
    await answer(KEEP_WAITING_ID);
    expect(win.webContents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    expect(deps.close).not.toHaveBeenCalled();
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it('开着 DevTools 时不弹(断点停住也会报无响应)', () => {
    const { win, dialogs } = setup();
    win.webContents.isDevToolsOpened.mockReturnValue(true);
    win.emit('unresponsive');
    expect(dialogs()).toHaveLength(0);
  });

  it('无响应期间真的崩溃 → 关掉无响应框,改弹崩溃框', () => {
    const { win, dialogs } = setup();
    win.emit('unresponsive');
    const signal = dialogs()[0]!.signal!;
    crash(win);
    expect(signal.aborted).toBe(true);
    expect(dialogs()).toHaveLength(2);
    expect(dialogs()[1]!.message).toContain('terminated unexpectedly');
  });
});

describe('popout 子窗归属(传递闭包)', () => {
  it('收集主窗打开的子窗及子窗再弹出的,不含别的主窗的子窗', () => {
    const w = (webContentsId: number, opener?: number) => ({ webContentsId, opener });
    const main = w(1);
    const a = w(2, 1);
    const b = w(3, 2); // 从 popout a 再弹出
    const other = w(4, 9);
    const found = popoutsOpenedBy(1, [main, b, a, other], (x) => x.opener);
    expect(found.sort((x, y) => x.webContentsId - y.webContentsId)).toEqual([a, b]);
  });
});

describe('三语文案', () => {
  it.each([
    ['zh', zh],
    ['ko', ko],
  ])('%s 有全部窗口异常文案', (_name, dict) => {
    for (const key of Object.keys(en).filter((k) => /^dialog\.window_(error|crashed|unresponsive)\./.test(k))) {
      expect((dict as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});
