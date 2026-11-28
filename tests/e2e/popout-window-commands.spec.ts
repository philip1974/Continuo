// popout 子窗里的窗口类命令与键盘焦点(VSCode:命令作用于触发它的窗口)。BDD: src/__tests__/command-discoverability/ 第 2 条、
// src/__tests__/keyboard-focus-parity/ 第 6 条、src/__tests__/shared-tab/。
// 1. 子窗里经命令面板「关闭窗口」→ 只关子窗(组收回主窗),主窗与主窗终端都在 —— 此前 IPC 发起方是主窗,关掉整个主窗连同终端。
// 2. 子窗里经命令面板「切换全屏」→ 子窗全屏、主窗不动 —— 此前切的是主窗。
// 3. 子窗里经命令面板「重新加载窗口」→ 重载主窗(VSCode 辅助窗口同);子窗随主窗卸载关闭、随 dock 布局恢复。
// 4. 只有终端的子窗里 F6 / ⇧F6 在 tab 栏 ↔ 终端之间切换,Tab 从 tab 到「打开视图…」—— 此前焦点困在终端里。
// 5. 非活动组里正显示的 dock tab 也 aria-selected=true、在 Tab 顺序里(每组一个);强调条只在活动组。
// Playwright 默认焦点模拟让每个窗口 document.hasFocus() 都为 true → 关掉它,用 BrowserWindow.focus() 真正切换窗口。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { DOCK_POPOUT, TERMINAL_INPUT, TERMINAL_PANEL_TAB } from './helpers/editor';
import { DOCK_OPEN_VIEW, openTreeItem } from './helpers/explorer';
import { COMMAND_SEARCH } from './helpers/palette';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const OUTPUT_TAB = /^(输出|Output|출력)/;

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui111a-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui111a-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'file-0.ts'), 'export const zero = 0;\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => win.evaluate(() => globalThis.__continuoTest !== undefined), { timeout: 15_000 }).toBe(true);
  return { app, win };
}

async function disableFocusEmulation(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}

const focusWindow = (app: ElectronApplication, popout: boolean): Promise<void> =>
  app.evaluate(({ BrowserWindow }, popout) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('popout=1') === popout)?.focus();
  }, popout);

const isFullScreen = (app: ElectronApplication, popout: boolean): Promise<boolean | null> =>
  app.evaluate(({ BrowserWindow }, popout) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popout=1') === popout);
    return w ? w.isFullScreen() : null;
  }, popout);

const runCommand = (win: Page, id: string): Promise<boolean> =>
  win.evaluate((id) => globalThis.__continuoTest!.executeCommand(id), id);

const groupOf = (tab: Locator): Locator => tab.locator('xpath=ancestor::*[contains(@class,"dv-groupview")]');

/** 主窗新建终端(返回其 dock tab,按面板 id 定位;标题会随前台程序变化)。 */
async function newTerminal(win: Page): Promise<Locator> {
  expect(await runCommand(win, 'terminal.new')).toBe(true);
  const byName = win.getByRole('tab', { name: TERMINAL_PANEL_TAB }).last();
  await expect(byName).toBeVisible({ timeout: 15_000 });
  const id = await byName.getAttribute('data-panel-id');
  return win.locator(`[role=tab][data-panel-id="${id}"]`);
}

/** 弹出 tab 所在组;返回子窗(已关焦点模拟、已获焦)。 */
async function popOut(app: ElectronApplication, win: Page, tab: Locator): Promise<Page> {
  await tab.click();
  await groupOf(tab).getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBeGreaterThan(1);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(child.locator('[data-testid=popout-host]')).toBeVisible({ timeout: 10_000 });
  await disableFocusEmulation(win);
  await disableFocusEmulation(child);
  await focusWindow(app, true);
  await expect.poll(() => child.evaluate(() => document.hasFocus())).toBe(true);
  return child;
}

/** 在子窗里按 ⇧⌘P、输入命令名、回车(命令面板画在子窗)。 */
async function runFromPalette(child: Page, query: string, title: RegExp): Promise<void> {
  await child.keyboard.press('ControlOrMeta+Shift+p');
  const input = child.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible({ timeout: 10_000 });
  await child.keyboard.type(query);
  await expect(child.getByRole('option').first()).toContainText(title, { timeout: 10_000 });
  // 「关闭窗口」回车即关掉子窗:按键动作随页面关闭而报错属正常
  await child.keyboard.press('Enter').catch((err: unknown) => {
    if (!child.isClosed()) throw err;
  });
}

const terminalText = (win: Page): Promise<string> =>
  win.evaluate(() => globalThis.__continuoTest!.readActiveTerminalText() ?? '');

test('子窗里经命令面板「关闭窗口」只关子窗:主窗与主窗终端都在,子窗的组收回主窗', async () => {
  test.setTimeout(120_000);
  const { app, win } = await launch();
  const term = await newTerminal(win);
  await expect.poll(() => terminalText(win), { timeout: 15_000 }).not.toBe('');
  expect(await runCommand(win, 'workbench.view.output')).toBe(true);
  const output = win.locator('.dv-tab').filter({ hasText: OUTPUT_TAB });
  const child = await popOut(app, win, output);
  await expect(child.locator('.dv-tab').filter({ hasText: OUTPUT_TAB })).toBeVisible();

  await runFromPalette(child, 'Close Window', /(关闭窗口|Close Window|창 닫기)/);

  await expect.poll(() => child.isClosed(), { timeout: 15_000 }).toBe(true);
  // 主窗还在(没被关),终端面板与会话都在,输出收回主窗
  await win.waitForTimeout(500);
  expect(win.isClosed()).toBe(false);
  expect(app.windows()).toEqual([win]);
  await expect(term).toBeVisible();
  await expect(output).toBeVisible({ timeout: 10_000 });
  await term.click();
  await expect.poll(() => terminalText(win), { timeout: 10_000 }).not.toBe('');
  await expect(win.getByRole('textbox', { name: TERMINAL_INPUT }).first()).toBeAttached();
});

test('子窗里经命令面板「切换全屏」→ 子窗全屏、主窗不动;再执行一次退出全屏', async () => {
  test.setTimeout(120_000);
  const { app, win } = await launch();
  expect(await runCommand(win, 'workbench.view.output')).toBe(true);
  const child = await popOut(app, win, win.locator('.dv-tab').filter({ hasText: OUTPUT_TAB }));
  expect(await isFullScreen(app, true)).toBe(false);

  await runFromPalette(child, 'Toggle Full Screen', /(切换全屏|Toggle Full Screen|전체 화면 설정\/해제)/);
  await expect.poll(() => isFullScreen(app, true), { timeout: 15_000 }).toBe(true);
  expect(await isFullScreen(app, false)).toBe(false);
  await expect(win.locator('.toast[data-level="error"]')).toHaveCount(0);

  // macOS 全屏动画结束后再切回(动画期间 setFullScreen 会被忽略)
  await child.waitForTimeout(1500);
  await focusWindow(app, true);
  await runFromPalette(child, 'Toggle Full Screen', /(切换全屏|Toggle Full Screen|전체 화면 설정\/해제)/);
  await expect.poll(() => isFullScreen(app, true), { timeout: 15_000 }).toBe(false);
  expect(await isFullScreen(app, false)).toBe(false);
  await child.waitForTimeout(1500);
});

test('子窗里经命令面板「重新加载窗口」→ 重载主窗;子窗随 dock 布局恢复', async () => {
  test.setTimeout(120_000);
  const { app, win } = await launch();
  expect(await runCommand(win, 'workbench.view.output')).toBe(true);
  const child = await popOut(app, win, win.locator('.dv-tab').filter({ hasText: OUTPUT_TAB }));
  await win.evaluate(() => {
    (globalThis as { __beforeReload?: boolean }).__beforeReload = true;
  });

  await runFromPalette(child, 'Reload Window', /(重新加载窗口|Reload Window|창 다시 로드)/);

  // 主窗文档换了(标记消失),子窗随主窗卸载关闭
  await expect
    .poll(() => win.evaluate(() => (globalThis as { __beforeReload?: boolean }).__beforeReload === true).catch(() => true), {
      timeout: 20_000,
    })
    .toBe(false);
  await expect.poll(() => child.isClosed(), { timeout: 15_000 }).toBe(true);
  // 恢复后输出仍在子窗(布局在重载前 flush)
  await expect
    .poll(() => app.windows().filter((w) => w !== win && !w.isClosed()).length, { timeout: 20_000 })
    .toBe(1);
  const restored = app.windows().find((w) => w !== win && !w.isClosed())!;
  await restored.waitForLoadState('domcontentloaded');
  await expect(restored.locator('.dv-tab').filter({ hasText: OUTPUT_TAB })).toBeVisible({ timeout: 15_000 });
});

test('只有终端的子窗:F6 / ⇧F6 在 tab ↔ 终端之间切换,Tab 从 tab 到「打开视图…」', async () => {
  test.setTimeout(120_000);
  const { app, win } = await launch();
  const term = await newTerminal(win);
  const id = await term.getAttribute('data-panel-id');
  const child = await popOut(app, win, term);
  const childTab = child.locator(`[role=tab][data-panel-id="${id}"]`);
  await expect(childTab).toBeVisible({ timeout: 10_000 });
  const input = child.getByRole('textbox', { name: TERMINAL_INPUT });
  await input.focus();
  await expect(input).toBeFocused();

  await child.keyboard.press('F6');
  await expect(childTab).toBeFocused();
  await child.keyboard.press('F6');
  await expect(input).toBeFocused();
  await child.keyboard.press('Shift+F6');
  await expect(childTab).toBeFocused();

  // tab 上 Tab → 本组标题栏的操作按钮(「更多操作」可达)
  const more = groupOf(childTab).getByRole('button', { name: DOCK_OPEN_VIEW });
  for (let i = 0; i < 4; i += 1) {
    if (await more.evaluate((el) => el === document.activeElement)) break;
    await child.keyboard.press('Tab');
  }
  await expect(more).toBeFocused();

  await child.keyboard.press('Shift+F6');
  await expect(input).toBeFocused();
  // 焦点一直在子窗(没被拉回主窗)
  expect(await child.evaluate(() => document.hasFocus())).toBe(true);
});

test('两个编辑器组:非活动组里正显示的 dock tab 也 aria-selected=true、tabIndex=0;强调条只在活动组', async () => {
  test.setTimeout(90_000);
  const { win } = await launch();
  await openTreeItem(win, /^file-0\.ts$/);
  const roots = win.locator('[data-editor-panel-root]');
  await expect(roots.first().locator('.cm-content')).toContainText('export const zero', { timeout: 10_000 });
  await roots.first().locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+Backslash');
  await expect(roots).toHaveCount(2, { timeout: 10_000 });
  // 点回第一组:第二组成为非活动组
  await roots.first().locator('.cm-content').click();

  const dockTabs = win.locator('.dv-tabs-container [role=tab][data-panel-id]');
  await expect(dockTabs).toHaveCount(2);
  const selected = win.locator('.dv-tabs-container [role=tab][data-panel-id][aria-selected="true"]');
  await expect(selected).toHaveCount(2);
  for (const tab of await selected.all()) await expect(tab).toHaveAttribute('tabindex', '0');
  // 强调条只有一条(全局活动组)
  await expect(win.locator('.dv-tabs-container [role=tab][data-panel-id] .bg-accent')).toHaveCount(1);
});
