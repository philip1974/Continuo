// 重启恢复全部主窗口(VSCode window.restoreWindows 默认 all):两个主窗口各开一个文件夹,退出重启后两个都恢复、焦点在最后
// 活动的窗口;设置里关掉「启动时恢复所有窗口」后只恢复一个(最后活动的)。BDD: src/__tests__/restore-windows-on-launch/
// 聚焦断言:主进程 BrowserWindow.getFocusedWindow()(系统级焦点),并在关掉 Playwright 焦点模拟(默认让每个窗口
// document.hasFocus() 都为 true)后核对各窗口 document.hasFocus()。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { explorerSidebar } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { GENERAL_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';
import { readPersistedExplorer } from './helpers/persisted-explorer';

const RESTORE_WINDOWS_SETTING = /^(启动时恢复所有窗口|Restore all windows on launch|시작 시 모든 창 복원)$/;

let userData = '';
let wsA = '';
let wsB = '';
let app: ElectronApplication | null = null;

test.beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'rwol-ud-'));
  wsA = mkdtempSync(path.join(tmpdir(), 'rwol-a-'));
  wsB = mkdtempSync(path.join(tmpdir(), 'rwol-b-'));
  writeFileSync(path.join(wsA, 'alpha.txt'), 'a\n');
  writeFileSync(path.join(wsB, 'bravo.txt'), 'b\n');
  seedExplorerJson(userData, { root: wsA });
});

test.afterEach(async () => {
  if (app) await closeDiscardingUnsaved(app).catch(() => undefined);
  app = null;
  for (const d of [userData, wsA, wsB]) rmSync(d, { recursive: true, force: true });
});

async function launch(): Promise<ElectronApplication> {
  app = await launchContinuo(userData);
  return app;
}

async function quit(a: ElectronApplication): Promise<void> {
  await a.close();
  app = null;
}

interface Persisted {
  restoreAllWindowsOnLaunch?: boolean;
  openWindowSeqs?: number[];
  windows: Array<{ windowSeq: number; workspace: { root: string | null } }>;
}

function persisted(): Persisted {
  return readPersistedExplorer(userData) as Persisted;
}

/** 主进程当前聚焦主窗的 windowSeq(取自 URL query);没有聚焦窗口 → null。 */
function focusedSeq(a: ElectronApplication): Promise<string | null> {
  return a.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getFocusedWindow();
    return w ? new URL(w.webContents.getURL()).searchParams.get('windowSeq') : null;
  });
}

async function focusSeq(a: ElectronApplication, seq: string): Promise<void> {
  await a.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()
      .find((w) => new URL(w.webContents.getURL()).searchParams.get('windowSeq') === s)!
      .focus();
  }, seq);
  await expect.poll(() => focusedSeq(a)).toBe(seq);
}

/** 关掉 Playwright 的焦点模拟后,该页面 document 是否真有焦点。 */
async function realHasFocus(page: Page): Promise<boolean> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  return page.evaluate(() => document.hasFocus());
}

const seqOf = (page: Page): string => new URL(page.url()).searchParams.get('windowSeq')!;

/** 主窗开着 wsA,再用 open-file 在新窗口打开 wsB;返回 [主窗, 新窗]。 */
async function openTwoWindows(a: ElectronApplication): Promise<[Page, Page]> {
  const main = await a.firstWindow();
  await expect(explorerSidebar(main)).toContainText('alpha.txt', { timeout: 15_000 });
  await a.evaluate(({ app: electronApp }, p) => {
    electronApp.emit('open-file', { preventDefault: () => undefined }, p);
  }, wsB);
  await expect.poll(() => a.windows().length, { timeout: 10_000 }).toBe(2);
  const second = a.windows().find((w) => w !== main)!;
  await expect(explorerSidebar(second)).toContainText('bravo.txt', { timeout: 15_000 });
  // 等新窗口的段(root = wsB)落盘
  await expect
    .poll(() => persisted().windows.find((w) => w.windowSeq === Number(seqOf(second)))?.workspace.root, {
      timeout: 10_000,
    })
    .toBe(wsB);
  return [main, second];
}

/** 等待恢复出来的主窗口数达到 n,返回 windowSeq → 页面。 */
async function restoredWindows(a: ElectronApplication, n: number): Promise<Map<string, Page>> {
  await expect.poll(() => a.windows().length, { timeout: 15_000 }).toBe(n);
  const bySeq = new Map<string, Page>();
  for (const p of a.windows()) bySeq.set(seqOf(p), p);
  return bySeq;
}

test('两个主窗口各开一个文件夹 → 退出重启两个都恢复(各自的文件夹),焦点在最后活动的窗口', async () => {
  test.setTimeout(120_000);
  let a = await launch();
  const [main, second] = await openTwoWindows(a);
  const mainSeq = seqOf(main);
  const secondSeq = seqOf(second);
  // 最后活动的是主窗(新窗建出时抢了焦点,再切回主窗)
  await focusSeq(a, mainSeq);
  await quit(a);

  expect(persisted().openWindowSeqs).toEqual([Number(secondSeq), Number(mainSeq)]);

  a = await launch();
  const bySeq = await restoredWindows(a, 2);
  await expect(explorerSidebar(bySeq.get(mainSeq)!)).toContainText('alpha.txt', { timeout: 15_000 });
  await expect(explorerSidebar(bySeq.get(secondSeq)!)).toContainText('bravo.txt', { timeout: 15_000 });
  await expect.poll(() => focusedSeq(a), { timeout: 10_000 }).toBe(mainSeq);
  await expect.poll(() => realHasFocus(bySeq.get(mainSeq)!)).toBe(true);
  await expect.poll(() => realHasFocus(bySeq.get(secondSeq)!)).toBe(false);

  // 再来一轮:这次最后活动的是第二个窗口 → 重启后焦点在它
  await focusSeq(a, secondSeq);
  await quit(a);
  a = await launch();
  const again = await restoredWindows(a, 2);
  await expect.poll(() => focusedSeq(a), { timeout: 10_000 }).toBe(secondSeq);
  await expect.poll(() => realHasFocus(again.get(secondSeq)!)).toBe(true);
  await expect.poll(() => realHasFocus(again.get(mainSeq)!)).toBe(false);
});

test('用户先关掉一个窗口再退出 → 重启只恢复退出时开着的那个(关掉的立即移出记录)', async () => {
  test.setTimeout(150_000);
  let a = await launch();
  const [main, second] = await openTwoWindows(a);
  const mainSeq = seqOf(main);
  const secondSeq = seqOf(second);
  await quit(a);
  a = await launch();
  await restoredWindows(a, 2);
  expect([...(persisted().openWindowSeqs ?? [])].sort()).toEqual([Number(mainSeq), Number(secondSeq)].sort());

  // 经 BrowserWindow.close() 走真实关窗流程(脏确认 + flush + closed 落盘);关掉即移出记录(未退出也已生效)
  await a.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()
      .find((w) => new URL(w.webContents.getURL()).searchParams.get('windowSeq') === s)
      ?.close();
  }, secondSeq);
  await expect.poll(() => a.windows().length, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => persisted().openWindowSeqs, { timeout: 10_000 }).toEqual([Number(mainSeq)]);
  await quit(a);

  a = await launch();
  const first = await a.firstWindow();
  expect(seqOf(first)).toBe(mainSeq);
  await expect(explorerSidebar(first)).toContainText('alpha.txt', { timeout: 15_000 });
  await first.waitForTimeout(2_000);
  expect(a.windows().length).toBe(1);
});

test('设置里关掉「启动时恢复所有窗口」→ 重启只恢复一个(最后活动的窗口)', async () => {
  test.setTimeout(120_000);
  let a = await launch();
  const [main, second] = await openTwoWindows(a);
  const secondSeq = seqOf(second);

  await main.getByRole('button', { name: SETTINGS }).click();
  const nav = main.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });
  await nav.getByRole('button', { name: GENERAL_TAB }).click();
  const toggle = main.getByRole('switch', { name: RESTORE_WINDOWS_SETTING });
  await expect(toggle).toHaveAttribute('aria-checked', 'true'); // 默认开
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => persisted().restoreAllWindowsOnLaunch, { timeout: 10_000 }).toBe(false);

  await focusSeq(a, secondSeq); // 最后活动的是第二个窗口
  await quit(a);

  a = await launch();
  const only = await a.firstWindow();
  expect(seqOf(only)).toBe(secondSeq);
  await expect(explorerSidebar(only)).toContainText('bravo.txt', { timeout: 15_000 });
  await only.waitForTimeout(2_000);
  expect(a.windows().length).toBe(1);
});
