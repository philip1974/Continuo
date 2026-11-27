// 唯一的编辑器组移到新窗口后,从主窗打开文件落在主窗且主窗保持获焦,接着打字进主窗打开的文件(VSCode:按获焦窗口的编辑器区取
// 活动组,主窗总保留一个编辑器组)。此前文件进了子窗的 tab 栏,焦点却留在主窗,打字落进主窗资源管理器。
// BDD: src/__tests__/popout-open-target/(打开文件)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { explorerTreeItem, openTreeItem } from './helpers/explorer';
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

const editors = (page: Page) => page.locator('[data-editor-panel-root] .cm-content');

async function noFocusEmulation(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}

const focusedWindow = (app: ElectronApplication): Promise<'main' | 'popout' | null> =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getFocusedWindow();
    return w ? (w.webContents.getURL().includes('popout=1') ? 'popout' : 'main') : null;
  });

const focusMain = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('popout=1'))?.focus();
  });

/** 打开 one.ts 后把唯一的编辑器组移到新窗口;回到主窗。 */
async function setup(): Promise<{ app: ElectronApplication; win: Page; child: Page }> {
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
  await expect(editors(win)).toContainText('export const one', { timeout: 10_000 });
  await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.moveEditorGroupToNewWindow'));
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(editors(child)).toContainText('export const one', { timeout: 10_000 });
  await expect(editors(win)).toHaveCount(0);
  await noFocusEmulation(win);
  await noFocusEmulation(child);
  await focusMain(app);
  await expect.poll(() => focusedWindow(app)).toBe('main');
  return { app, win, child };
}

test('主窗没有编辑器组:资源管理器单击 / ⌘P 打开 → 落在主窗新建的编辑器组,主窗仍获焦,打字进主窗的文件', async () => {
  test.setTimeout(120_000);
  const { app, win, child } = await setup();

  // 资源管理器单击(预览):文件在主窗打开,子窗不变,焦点留在主窗
  await explorerTreeItem(win, /^two\.ts$/).click();
  await expect(editors(win)).toContainText('export const two', { timeout: 10_000 });
  await expect(editors(child)).toHaveCount(1);
  await expect(editors(child)).not.toContainText('export const two');
  expect(await focusedWindow(app)).toBe('main');

  // ⌘P 打开子窗里开着的 one.ts → 在主窗的组里也打开,焦点进主窗编辑器;打字进主窗
  await win.keyboard.press('ControlOrMeta+KeyP');
  const qo = win.getByRole('combobox');
  await expect(qo).toBeVisible({ timeout: 5_000 });
  await qo.fill('one.ts');
  await expect(win.getByRole('option').first()).toContainText('one.ts', { timeout: 10_000 });
  await win.keyboard.press('Enter');
  await expect(editors(win)).toContainText('export const one', { timeout: 10_000 });
  await expect.poll(() => win.evaluate(() => document.activeElement?.closest('.cm-content') != null)).toBe(true);
  await win.keyboard.press('ControlOrMeta+End');
  await win.keyboard.type('zz');
  await expect(editors(win)).toContainText('zz');
  expect(await focusedWindow(app)).toBe('main');
  // 子窗的编辑器显示同一文档(共享内容),但窗口焦点仍在主窗、子窗 tab 栏没有多出 two.ts
  await expect(child.getByRole('tab', { name: /two\.ts/ })).toHaveCount(0);
});
