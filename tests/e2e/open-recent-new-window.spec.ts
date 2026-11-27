// 「打开最近的文件夹」里 ⌘Enter(Windows / Linux Ctrl+Enter)在新窗口打开(VSCode openRecent:ctrlCmd → forceNewWindow),本窗口
// 不切换;该文件夹已在别的窗口打开 → 聚焦那个窗口,不再开窗。BDD: src/__tests__/workbench-missing-commands/(§3)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { explorerSidebar } from './helpers/explorer';
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

const focusedUrl = (app: ElectronApplication): Promise<string | null> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL() ?? null);

async function openRecentAndPick(win: Page, name: string): Promise<void> {
  await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.openRecent'));
  const input = win.getByRole('combobox');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(name);
  await expect(win.getByRole('option')).toHaveCount(1, { timeout: 5_000 });
  await win.keyboard.press('ControlOrMeta+Enter');
}

test('⌘Enter → 在新窗口打开,本窗口 root 不变;再对已在新窗口打开的文件夹 ⌘Enter → 聚焦那个窗口,不多开', async () => {
  test.setTimeout(120_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'ui145-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui145-cur-'));
  const other = mkdtempSync(path.join(tmpdir(), 'ui145-other-'));
  dirs.push(ud, ws, other);
  writeFileSync(path.join(ws, 'current-marker.txt'), 'x\n');
  writeFileSync(path.join(other, 'other-marker.txt'), 'y\n');
  seedExplorerJson(ud, { root: ws, recentRoots: [ws, other] });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await waitForAppReady(win);
  await waitForTestHooks(win);
  await expect(explorerSidebar(win)).toContainText('current-marker.txt', { timeout: 15_000 });

  await openRecentAndPick(win, path.basename(other));
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
  const second = app.windows().find((w) => w !== win)!;
  await second.waitForLoadState('domcontentloaded');
  await expect(explorerSidebar(second)).toContainText('other-marker.txt', { timeout: 15_000 });
  // 本窗口不切换
  await expect(explorerSidebar(win)).toContainText('current-marker.txt');
  await expect(explorerSidebar(win)).not.toContainText('other-marker.txt');

  // 回到第一个窗口,再 ⌘Enter 打开同一文件夹 → 聚焦第二个窗口,不开第三个
  await app.evaluate(({ BrowserWindow }, url) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.focus();
  }, win.url());
  await expect.poll(() => focusedUrl(app)).toBe(win.url());
  await openRecentAndPick(win, path.basename(other));
  await expect.poll(() => focusedUrl(app), { timeout: 10_000 }).toBe(second.url());
  await win.waitForTimeout(500);
  expect(app.windows().length).toBe(2);
});
