// 首选项:颜色主题 / 在浅色和深色主题之间切换(BDD: src/__tests__/theme-commands/)。
// 1. 命令面板搜到两条命令(本地化标题 / 英文原名);颜色主题选择器:选中当前项、↑↓ 预览(只改 <html> class,不写设置)、
//    Esc 恢复、Enter 写设置;跟随系统按 prefers-color-scheme(Playwright 默认模拟 light → 显式模拟)
// 2. 切换浅深
// 3. popout 子窗里经命令面板打开:选择器画在子窗、预览作用于子窗,主窗没有选择器
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DOCK_POPOUT } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';
import { commandPaletteInput } from './helpers/palette';
import { dispatchModKey } from './helpers/hotkeys';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const THEME_PICKER = /^(搜索颜色主题|Search color themes|색 테마 검색)$/;
const COLOR_THEME_CMD = /(首选项:\s*颜色主题|Preferences:\s*Color Theme|기본 설정:\s*색 테마)/;
const TOGGLE_CMD = /(在浅色和深色主题之间切换|Toggle between Light\/Dark Themes|밝은 테마와 어두운 테마 간 전환)/;

const picker = (page: Page) => page.getByRole('combobox', { name: THEME_PICKER });
const selectedMode = (page: Page) =>
  page.locator('[role="option"][aria-selected="true"]').getAttribute('data-theme-mode');
const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains('dark'));
const themeSetting = (page: Page) => page.evaluate(() => globalThis.__continuoTest!.getSettingValue('general.theme'));

async function launch(withEditor: boolean): Promise<{ app: ElectronApplication; win: Page; ws: string }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui108-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui108-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'main-file.ts'), 'export const main = 1;\n');
  writeFileSync(path.join(ws, 'child-file.ts'), 'export const child = 2;\n');
  if (withEditor) seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await waitForAppReady(win);
  await waitForTestHooks(win);
  return { app, win, ws };
}

/** 命令面板里按 query 执行第一条匹配命令(期望它的标题匹配 title)。 */
async function runFromPalette(page: Page, query: string, title: RegExp): Promise<void> {
  await dispatchModKey(page, 'p', { shift: true });
  await expect(commandPaletteInput(page)).toBeVisible({ timeout: 5_000 });
  await commandPaletteInput(page).fill(query);
  await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveText(title, { timeout: 5_000 });
  await commandPaletteInput(page).press('Enter');
}

test('颜色主题:命令面板可搜到;选中当前项;↑↓ 预览不写设置;Esc 恢复;Enter 生效;跟随系统按系统配色', async () => {
  test.setTimeout(90_000);
  const { win } = await launch(false);
  expect(await isDark(win)).toBe(true);

  // 英文原名也能搜到(界面语言不论)
  await runFromPalette(win, 'Color Theme', COLOR_THEME_CMD);
  await expect(picker(win)).toBeFocused({ timeout: 5_000 });
  await expect(win.locator('[role="option"]')).toHaveCount(3);
  await expect.poll(() => selectedMode(win)).toBe('dark');

  // ↑ → 亮色预览:<html> 去掉 dark,设置值不变
  await picker(win).press('ArrowUp');
  await expect.poll(() => selectedMode(win)).toBe('light');
  await expect.poll(() => isDark(win)).toBe(false);
  expect(await themeSetting(win)).toBeUndefined();
  // Esc → 关闭并恢复暗色
  await picker(win).press('Escape');
  await expect(picker(win)).toHaveCount(0);
  await expect.poll(() => isDark(win)).toBe(true);
  expect(await themeSetting(win)).toBeUndefined();

  // 跟随系统:预览按 prefers-color-scheme(Playwright 默认模拟 light,显式设成 light / dark)
  await win.emulateMedia({ colorScheme: 'light' });
  await runFromPalette(win, 'Color Theme', COLOR_THEME_CMD);
  await picker(win).press('ArrowDown');
  await expect.poll(() => selectedMode(win)).toBe('system');
  await expect.poll(() => isDark(win)).toBe(false);
  await win.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => isDark(win)).toBe(true);
  await picker(win).press('Escape');

  // Enter → 写入亮色并关闭
  await runFromPalette(win, 'Color Theme', COLOR_THEME_CMD);
  await picker(win).press('ArrowUp');
  await picker(win).press('Enter');
  await expect(picker(win)).toHaveCount(0);
  await expect.poll(() => themeSetting(win)).toBe('light');
  expect(await isDark(win)).toBe(false);

  // 再打开:选中的是当前(亮色),行尾标「当前」
  await runFromPalette(win, 'Color Theme', COLOR_THEME_CMD);
  await expect.poll(() => selectedMode(win)).toBe('light');
  await expect(win.locator('[role="option"][data-theme-mode="light"]')).toContainText(/(当前|Current|현재)/);
  await picker(win).press('Escape');
});

test('在浅色和深色主题之间切换:暗 → 亮 → 暗', async () => {
  test.setTimeout(60_000);
  const { win } = await launch(false);
  await runFromPalette(win, 'Toggle between Light', TOGGLE_CMD);
  await expect.poll(() => isDark(win)).toBe(false);
  expect(await themeSetting(win)).toBe('light');
  await runFromPalette(win, 'Toggle between Light', TOGGLE_CMD);
  await expect.poll(() => isDark(win)).toBe(true);
  expect(await themeSetting(win)).toBe('dark');
});

async function disableFocusEmulation(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}

test('popout 子窗里打开颜色主题:选择器画在子窗,预览作用于子窗,Esc 恢复;Enter 后两个窗口都生效', async () => {
  test.setTimeout(120_000);
  const { app, win } = await launch(true);
  const editorRoots = (page: Page) => page.locator('[data-editor-panel-root]');
  await openTreeItem(win, /^child-file\.ts$/);
  await expect(editorRoots(win).locator('.cm-content')).toContainText('export const child', { timeout: 10_000 });
  await editorRoots(win).locator('xpath=ancestor::*[contains(@class,"dv-groupview")]').getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBeGreaterThan(1);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(editorRoots(child).locator('.cm-content')).toContainText('export const child', { timeout: 10_000 });
  await disableFocusEmulation(win);
  await disableFocusEmulation(child);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('popout=1'))?.focus();
  });
  await editorRoots(child).locator('.cm-content').click();
  expect(await isDark(child)).toBe(true);

  await runFromPalette(child, 'Color Theme', COLOR_THEME_CMD);
  await expect(picker(child)).toBeFocused({ timeout: 5_000 });
  await expect(win.locator('[role="dialog"]')).toHaveCount(0);
  await picker(child).press('ArrowUp');
  await expect.poll(() => isDark(child)).toBe(false);
  await picker(child).press('Escape');
  await expect(picker(child)).toHaveCount(0);
  await expect.poll(() => isDark(child)).toBe(true);

  await runFromPalette(child, 'Color Theme', COLOR_THEME_CMD);
  await picker(child).press('ArrowUp');
  await picker(child).press('Enter');
  await expect.poll(() => isDark(child)).toBe(false);
  await expect.poll(() => isDark(win)).toBe(false);
  expect(await themeSetting(win)).toBe('light');
});
