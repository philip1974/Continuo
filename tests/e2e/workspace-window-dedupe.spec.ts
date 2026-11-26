// 同一文件夹只在一个窗口打开(VSCode 同):打开一个已在某窗口打开的文件夹 → 聚焦那个窗口,当前窗口不变。
// BDD: src/__tests__/workspace-window-dedupe/
// 聚焦断言用主进程的 BrowserWindow.getFocusedWindow()(系统级焦点,不受 Playwright 焦点模拟影响)。
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { EXPLORER_NO_FOLDER_OPEN_TEXT, explorerSidebar } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launchWithWorkspace(): Promise<{ app: ElectronApplication; main: Page; ws: string }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'wsdd-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'wsdd-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'marker.txt'), 'x\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const main = await app.firstWindow();
  await expect(explorerSidebar(main)).toContainText('marker.txt', { timeout: 15_000 });
  return { app, main, ws };
}

/** 主进程当前聚焦主窗的 windowSeq(取自 URL query);没有聚焦窗口 → null。 */
function focusedSeq(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getFocusedWindow();
    return w ? new URL(w.webContents.getURL()).searchParams.get('windowSeq') : null;
  });
}

/** 关掉 Playwright 的焦点模拟后,该页面 document 是否真有焦点。 */
async function realHasFocus(page: Page): Promise<boolean> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  return page.evaluate(() => document.hasFocus());
}

const seqOf = (page: Page): string | null => new URL(page.url()).searchParams.get('windowSeq');

async function openNewEmptyWindow(app: ElectronApplication, main: Page): Promise<Page> {
  await main.evaluate(() => globalThis.__continuoTest!.executeCommand('window.new'));
  await expect.poll(() => app.windows().length, { timeout: 10_000 }).toBe(2);
  const second = app.windows().find((w) => w !== main)!;
  await second.waitForLoadState('domcontentloaded');
  await expect(explorerSidebar(second)).toContainText(EXPLORER_NO_FOLDER_OPEN_TEXT, { timeout: 15_000 });
  return second;
}

test('新窗口「最近打开」里点已在主窗打开的文件夹 → 聚焦主窗,新窗口保持空,不多开窗口', async () => {
  test.setTimeout(90_000);
  const { app, main, ws } = await launchWithWorkspace();
  const second = await openNewEmptyWindow(app, main);
  await app.evaluate(({ BrowserWindow }, url) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.focus();
  }, second.url());
  await expect.poll(() => focusedSeq(app)).toBe(seqOf(second));

  await explorerSidebar(second)
    .getByRole('button', { name: new RegExp(`^${path.basename(ws)}[，,]`) })
    .click();

  await expect.poll(() => focusedSeq(app), { timeout: 10_000 }).toBe(seqOf(main));
  await expect.poll(() => realHasFocus(main)).toBe(true);
  await expect.poll(() => realHasFocus(second)).toBe(false);
  // 新窗口不切过去(稍等,确认不是「还没来得及切」)
  await main.waitForTimeout(500);
  await expect(explorerSidebar(second)).toContainText(EXPLORER_NO_FOLDER_OPEN_TEXT);
  await expect(explorerSidebar(second)).not.toContainText('marker.txt');
  expect(app.windows().length).toBe(2);
});

test('open-file / 在新窗口打开一个已打开的文件夹 → 聚焦那个窗口,不新建窗口', async () => {
  test.setTimeout(90_000);
  const { app, main, ws } = await launchWithWorkspace();
  const second = await openNewEmptyWindow(app, main);
  await app.evaluate(({ BrowserWindow }, url) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.focus();
  }, second.url());
  await expect.poll(() => focusedSeq(app)).toBe(seqOf(second));

  // 经软链路径打开(realpath 后与主窗 root 同一目录)
  const linkDir = mkdtempSync(path.join(tmpdir(), 'wsdd-link-'));
  dirs.push(linkDir);
  const link = path.join(linkDir, 'ws-link');
  symlinkSync(ws, link);
  await app.evaluate(({ app: electronApp }, p) => {
    electronApp.emit('open-file', { preventDefault: () => undefined }, p);
  }, link);

  await expect.poll(() => focusedSeq(app), { timeout: 10_000 }).toBe(seqOf(main));
  await main.waitForTimeout(500);
  expect(app.windows().length).toBe(2);
});
