// 真实 Electron 下主窗渲染进程崩溃 / 无响应的提示与恢复(单元规范见 src/__tests__/window-crash-recovery/)。
// 原生 messageBox 无法由 Playwright 点击 → 在 main 里替换 dialog.showMessageBox 记录调用并按需应答(同 dirty-close-confirm.spec)。
import { test, expect } from './fixtures/with-workspace';
import type { ElectronApplication, Page } from '@playwright/test';
import { EDITOR_UNSAVED_CHANGES_SELECTOR, TERMINAL_INPUT, TERMINAL_PANEL_TAB } from './helpers/editor';
import { waitForTestHooks } from './helpers/app-ready';

interface DialogCall {
  readonly message: string;
  readonly detail: string;
  readonly buttons: string[];
  aborted?: boolean;
}

/** response === null:不应答(只在 signal 触发时按 cancelId 结束)。 */
const stubDialog = (app: ElectronApplication, response: number | null) =>
  app.evaluate(({ dialog }, r) => {
    const g = globalThis as unknown as { __winErrCalls?: DialogCall[] };
    g.__winErrCalls = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const opts = args.find((a) => a && typeof a === 'object' && 'buttons' in (a as object)) as {
        message?: string;
        detail?: string;
        buttons?: string[];
        cancelId?: number;
        signal?: AbortSignal;
      };
      const call: DialogCall = { message: opts.message ?? '', detail: opts.detail ?? '', buttons: opts.buttons ?? [] };
      g.__winErrCalls!.push(call);
      if (r !== null) return { response: r, checkboxChecked: false };
      return new Promise((resolve) => {
        opts.signal?.addEventListener('abort', () => {
          call.aborted = true;
          resolve({ response: opts.cancelId ?? 0, checkboxChecked: false });
        });
      });
    }) as unknown as typeof dialog.showMessageBox;
  }, response);

const calls = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __winErrCalls?: DialogCall[] }).__winErrCalls ?? []);

const mainWindowState = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    const main = all.find((w) => !w.webContents.getURL().includes('popout=1'));
    return { count: all.length, crashed: main?.webContents.isCrashed() ?? null };
  });

/** 终端 tab 标题(shell 名:zsh / bash / fish …,或「终端」三语)。 */
const TERMINAL_TAB_SOURCE = '^(zsh|bash|fish|sh|Terminal|终端|터미널)';

const CRASH_MESSAGE = /(terminated unexpectedly|窗口意外终止|예기치 않게 종료)/;

async function openDirtyFile(window: Page): Promise<void> {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({ timeout: 5_000 });
}

test('主窗崩溃(有 popout、有未保存文件)→ 只弹一次框并列出丢失的文件;重新打开 → 重新加载、子窗一并关闭', async ({
  electronApp,
  window,
}) => {
  test.setTimeout(90_000);
  await openDirtyFile(window);
  // 等脏态上报到达 main(崩溃框据此列出文件)
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isDocumentEdited() ?? false),
    )
    .toBe(process.platform === 'darwin');
  if (process.platform !== 'darwin') await window.waitForTimeout(500);

  // 同 quit-with-popout.spec:直接 window.open popout URL(query 只有 popout=1),走同一个 windowOpenHandler。
  const opened = await window.evaluate(() => {
    const page = globalThis as unknown as Window;
    const url = new URL(page.location.href);
    url.search = '';
    url.searchParams.set('popout', '1');
    return page.open(url.toString()) !== null;
  });
  expect(opened).toBe(true);
  await expect.poll(async () => (await mainWindowState(electronApp)).count, { timeout: 10_000 }).toBe(2);

  await stubDialog(electronApp, 0); // 0 = 重新打开
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => !w.webContents.getURL().includes('popout=1'))!
      .webContents.forcefullyCrashRenderer();
  });

  await expect.poll(async () => (await calls(electronApp)).length, { timeout: 10_000 }).toBeGreaterThan(0);
  // 子窗同进程也崩了,但框只弹一次(页面已崩溃,不能用 page.waitForTimeout)
  await new Promise((r) => setTimeout(r, 500));
  const shown = await calls(electronApp);
  expect(shown).toHaveLength(1);
  expect(shown[0]!.message).toMatch(CRASH_MESSAGE);
  expect(shown[0]!.detail).toContain('a.ts');
  expect(shown[0]!.buttons).toHaveLength(2);

  // 重新打开:主窗重新加载(不再是崩溃态),空壳子窗被销毁
  await expect
    .poll(() => mainWindowState(electronApp), { timeout: 15_000 })
    .toEqual({ count: 1, crashed: false });
  // Playwright 的 Page 在崩溃后保持 crashed 状态:经 main 在重载后的新 renderer 里查工作区树已恢复。
  await expect
    .poll(
      () =>
        electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!
            .webContents.executeJavaScript(`[...document.querySelectorAll('[role=treeitem]')].some((e) => e.textContent.includes('src'))`)
            .catch(() => false),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
});

test('窗口无响应 → 弹「窗口没有响应」;恢复响应时框被关掉,窗口不受影响', async ({ electronApp, window }) => {
  await expect(window.locator('text=src').first()).toBeVisible({ timeout: 15_000 });
  await stubDialog(electronApp, null);
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.emit('unresponsive');
  });
  await expect.poll(async () => (await calls(electronApp)).length).toBe(1);
  const [call] = await calls(electronApp);
  expect(call!.message).toMatch(/(not responding|没有响应|응답하지 않습니다)/);
  expect(call!.buttons).toHaveLength(3);

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.emit('responsive');
  });
  await expect.poll(async () => (await calls(electronApp))[0]?.aborted).toBe(true);
  expect(await mainWindowState(electronApp)).toEqual({ count: 1, crashed: false });
  await expect(window.locator('text=src').first()).toBeVisible();
});

// 崩溃恢复后终端历史按录制时的尺寸回放(BDD: src/__tests__/terminal-replay-dimensions/):窄窗口里产生的、带光标上移的输出,
// 窗口变宽后由 xterm 重排;崩溃 → 重新打开后回放的结果须与崩溃前屏幕一致(按当前宽度直接回放时光标上移会落到别的行)。
test('崩溃恢复后终端历史按录制尺寸回放,与崩溃前屏幕一致', async ({ electronApp, window }) => {
  test.skip(process.platform === 'win32', 'POSIX shell printf');
  test.setTimeout(90_000);
  const terminalText = () => window.evaluate(() => globalThis.__continuoTest!.readActiveTerminalText() ?? '');
  const setWidth = (width: number) =>
    electronApp.evaluate(({ BrowserWindow }, w) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.setContentSize(w, 700);
    }, width);
  const run = async (command: string) => {
    await window.keyboard.type(command);
    await window.keyboard.press('Enter');
  };
  /** 跑 `tput cols` 读 PTY 当前列数(输出行带标记,避免与命令回显混淆)。 */
  const ptyCols = async (marker: string): Promise<number> => {
    await run(`echo ${marker}$(tput cols)`);
    let cols = 0;
    await expect
      .poll(async () => {
        const m = new RegExp(`^${marker}(\\d+)`, 'm').exec(await terminalText());
        cols = m ? Number(m[1]) : 0;
        return cols;
      }, { timeout: 10_000 })
      .toBeGreaterThan(0);
    return cols;
  };

  await waitForTestHooks(window);
  expect(await window.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
  await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  const input = window.getByRole('textbox', { name: TERMINAL_INPUT });
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.focus();
  await expect.poll(terminalText, { timeout: 15_000 }).not.toBe('');

  await setWidth(560);
  await window.waitForTimeout(600); // fit + resize 防抖
  const narrow = await ptyCols('NARROW=');
  const len = narrow + 8;
  // 一行 len 个 A(窄宽度下自动换成两行)→ 光标上移一行 → 写 Z
  await run(`printf '%s\\033[1AZ\\n' ${'A'.repeat(len)}`);
  // 等输出在窄宽度下解析完再变宽(否则 xterm 先变宽再解析,屏幕本身就不是窄宽度下的样子)
  await run('echo DONE-$((1+1))');
  await expect.poll(async () => (await terminalText()).includes('\nDONE-2'), { timeout: 10_000 }).toBe(true);
  await setWidth(1500);
  await window.waitForTimeout(600);
  const wide = await ptyCols('WIDE=');
  expect(wide).toBeGreaterThan(len);
  // printf 那条命令到 WIDE= 之间的屏幕内容(命令回显 + 输出,均跨过窄宽度换行与光标上移)。
  const block = (text: string): string | null => {
    const from = text.indexOf("printf '%s");
    const to = text.indexOf('WIDE=', from);
    return from < 0 || to < 0 ? null : text.slice(from, to);
  };
  await expect.poll(async () => block(await terminalText()), { timeout: 10_000 }).not.toBeNull();
  const before = block(await terminalText());
  expect(before).toContain('Z');

  await stubDialog(electronApp, 0);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer());
  await expect.poll(async () => (await calls(electronApp)).length, { timeout: 10_000 }).toBe(1);
  const after = async () =>
    electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!
        .webContents.executeJavaScript('globalThis.__continuoTest?.readActiveTerminalText() ?? ""')
        .catch(() => ''),
    );
  // 重载后布局恢复时活动 tab 未必是终端:点终端 tab(Playwright 的 Page 已是 crashed,经 main 在新 renderer 里点)。
  const activateTerminal = () =>
    electronApp.evaluate(({ BrowserWindow }, title) =>
      BrowserWindow.getAllWindows()[0]!
        .webContents.executeJavaScript(
          `(() => { const t = [...document.querySelectorAll('[role=tab]')].find((e) => new RegExp(${JSON.stringify(title)}).test(e.textContent ?? '')); if (!t) return false; for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) t.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0 })); return t.getAttribute('aria-selected') === 'true'; })()`,
        )
        .catch(() => false),
    TERMINAL_TAB_SOURCE);
  await expect.poll(activateTerminal, { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => block(await after()), { timeout: 20_000 }).toBe(before);
});
