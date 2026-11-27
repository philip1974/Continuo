// 切换窗口(workbench.action.switchWindow,mac ⌃W):列出主窗口与 popout 子窗,当前窗口标注,可过滤,选中聚焦;终端里 ⌃W 交给 shell。
// BDD: src/__tests__/switch-window/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { openTreeItem } from './helpers/explorer';
import { TERMINAL_PANEL_TAB } from './helpers/editor';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mac = process.platform === 'darwin';
const CURRENT = /(Current Window|当前窗口|현재 창)/;

const focusedId = (app: ElectronApplication): Promise<number | null> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null);

const idOf = (app: ElectronApplication, page: Page): Promise<number> =>
  app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.id, page.url());

async function noFocusEmulation(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}

/** 主窗开 one.ts 并把编辑器组移到新窗口,另开一个空主窗口;回到第一个主窗。 */
async function setup(): Promise<{ app: ElectronApplication; win: Page; child: Page; second: Page }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui145-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui145-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'one.ts'), 'export const one = 1;\n');
  writeFileSync(path.join(ws, 'two.ts'), 'export const two = 2;\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await waitForAppReady(win);
  await waitForTestHooks(win);
  await openTreeItem(win, /^one\.ts$/);
  await expect(win.locator('[data-editor-panel-root] .cm-content')).toContainText('export const one', { timeout: 10_000 });
  await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.moveEditorGroupToNewWindow'));
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  await win.evaluate(() => globalThis.__continuoTest!.executeCommand('window.new'));
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(3);
  const second = app.windows().find((w) => w !== win && w !== child)!;
  await second.waitForLoadState('domcontentloaded');
  await waitForAppReady(second);
  for (const p of [win, child, second]) await noFocusEmulation(p);
  const winId = await idOf(app, win);
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.focus(), winId);
  await expect.poll(() => focusedId(app)).toBe(winId);
  return { app, win, child, second };
}

test('列出主窗口与子窗、当前窗口标注、按名称过滤、选中聚焦;子窗里打开时当前窗口是子窗', async () => {
  test.setTimeout(150_000);
  const { app, win, child, second } = await setup();
  const [winId, childId, secondId] = await Promise.all([idOf(app, win), idOf(app, child), idOf(app, second)]);

  // 主窗:在编辑器里按 ⌃W(mac)/ 命令(其它平台无默认键)→ 选择器画在主窗
  await openTreeItem(win, /^two\.ts$/);
  await expect(win.locator('[data-editor-panel-root] .cm-content')).toContainText('export const two', { timeout: 10_000 });
  if (mac) await win.keyboard.press('Control+KeyW');
  else await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.switchWindow'));
  const options = win.getByRole('option');
  await expect(options).toHaveCount(3, { timeout: 10_000 });
  const ids = await options.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-window-id'))));
  expect(new Set(ids)).toEqual(new Set([winId, childId, secondId]));
  // 子窗排在所属主窗之后
  expect(ids.indexOf(childId)).toBe(ids.indexOf(winId) + 1);
  await expect(win.locator(`[data-window-id="${winId}"]`)).toContainText(CURRENT);
  await expect(win.locator(`[data-window-id="${secondId}"]`)).not.toContainText(CURRENT);
  // 初始选中当前窗口的下一个
  await expect(win.locator(`[data-window-id="${childId}"]`)).toHaveAttribute('aria-selected', 'true');

  // 按名称过滤:子窗标题含 one.ts
  await win.getByRole('combobox').fill('one.ts');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveAttribute('data-window-id', String(childId));
  await win.keyboard.press('Enter');
  await expect.poll(() => focusedId(app), { timeout: 10_000 }).toBe(childId);
  await expect(win.getByRole('combobox')).toHaveCount(0);

  // 子窗里打开:选择器画在子窗,当前窗口是子窗;选第二个主窗口 → 聚焦它
  // (子窗跑不了测试钩子,只能按键;其它平台无默认键)
  if (!mac) return;
  await child.locator('[data-editor-panel-root] .cm-content').click();
  await child.keyboard.press('Control+KeyW');
  await expect(child.getByRole('option')).toHaveCount(3, { timeout: 10_000 });
  await expect(child.locator(`[data-window-id="${childId}"]`)).toContainText(CURRENT);
  await child.locator(`[data-window-id="${secondId}"]`).click();
  await expect.poll(() => focusedId(app), { timeout: 10_000 }).toBe(secondId);
});

test('终端获焦时 ⌃W 交给 shell(删前一个词),不打开选择器(mac)', async () => {
  test.skip(!mac, '⌃W 只在 mac 上是默认键');
  test.setTimeout(90_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'ui145-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui145-ws-'));
  dirs.push(ud, ws);
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await waitForAppReady(win);
  await waitForTestHooks(win);
  expect(await win.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
  const tab = win.getByRole('tab', { name: TERMINAL_PANEL_TAB });
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await tab.click();
  await win.locator('.xterm-helper-textarea').first().focus();
  const text = () => win.evaluate(() => globalThis.__continuoTest!.readActiveTerminalText() ?? '');
  // shell 就绪后再输入(提示符出现)
  await expect.poll(async () => (await text()).trim().length, { timeout: 20_000 }).toBeGreaterThan(0);
  await win.keyboard.type('echo keep1 drop2');
  await expect.poll(text, { timeout: 15_000 }).toContain('drop2');
  await win.keyboard.press('Control+KeyW');
  await expect(win.getByRole('dialog')).toHaveCount(0);
  await win.keyboard.press('Enter');
  // shell 删掉了前一个词:执行的是 `echo keep1`
  await expect.poll(text, { timeout: 15_000 }).toMatch(/^keep1\s*$/m);
  expect(await text()).not.toContain('drop2');
  await expect(win.getByRole('dialog')).toHaveCount(0);
});
