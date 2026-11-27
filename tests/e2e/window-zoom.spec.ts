// 窗口缩放级别所有窗口统一(VSCode window.zoomLevel;BDD: src/__tests__/window-zoom/):
// 1. 主窗 ⌘= / 菜单「放大」后,弹出的 popout 子窗与 ⇧⌘N 新窗口同一级别;重启后保持
// 2. 设置页改「缩放级别」即时作用于所有窗口;「恢复默认」/ 重置缩放回到 0;命令面板显示默认键
// E2E 模式下应用菜单为 null,菜单项经 main 的 e2e 钩子(__continuoAppMenu)按路径点击(与真实点击同一路径)。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DOCK_POPOUT } from './helpers/editor';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { GENERAL_TAB, openSettingsTab, SETTINGS } from './helpers/settings';
import { COMMAND_LIST, commandPaletteInput, openCommandPalette } from './helpers/palette';
import type { AppMenuE2eHook, MenuSnapshotItem } from '../../electron/main/app-menu-e2e';

const ZOOM_LEVEL_SETTING = /^(缩放级别|Zoom level|확대\/축소 수준)$/;
// macOS 顶层:应用 0 / 文件 1 / 编辑 2 / 选择 3 / 显示 4 …;其它平台没有应用菜单
const FILE = process.platform === 'darwin' ? 1 : 0;
const VIEW = process.platform === 'darwin' ? 4 : 3;

let userData = '';
let workspace = '';
let app: ElectronApplication | null = null;

test.beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'ui107b-zoom-ud-'));
  workspace = mkdtempSync(path.join(tmpdir(), 'ui107b-zoom-ws-'));
  writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 1;\n');
  seedExplorerJson(userData, { root: workspace });
});

test.afterEach(async () => {
  if (app) await closeDiscardingUnsaved(app).catch(() => undefined);
  app = null;
  rmSync(userData, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; main: Page }> {
  const a = await launchContinuo(userData);
  app = a;
  const main = await a.firstWindow();
  await expect(main.getByRole('button', { name: SETTINGS })).toBeVisible({ timeout: 15_000 });
  const cdp = await main.context().newCDPSession(main);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  return { app: a, main };
}

/** 每个窗口(按 id 排序)的 [是否 popout, 缩放级别]。 */
const zoomLevels = (a: ElectronApplication): Promise<Array<[boolean, number]>> =>
  a.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .sort((x, y) => x.id - y.id)
      .map((w): [boolean, number] => [w.webContents.getURL().includes('popout=1'), w.webContents.getZoomLevel()]),
  );

const mainWindowId = (a: ElectronApplication): Promise<number> =>
  a.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.webContents.getURL().includes('popout=1'))
      .sort((x, y) => x.id - y.id)[0]!.id,
  );

async function clickMenu(a: ElectronApplication, p: readonly number[]): Promise<void> {
  const winId = await mainWindowId(a);
  const ok = await a.evaluate(
    (_e, { p, winId }) => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.click(p, winId),
    { p, winId },
  );
  expect(ok).toBe(true);
}

async function menuPathOf(a: ElectronApplication, top: number, id: string): Promise<number[]> {
  const items = await a.evaluate(() =>
    (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.snapshot(),
  );
  const list: readonly MenuSnapshotItem[] = items[top]!.submenu ?? [];
  const i = list.findIndex((m) => m.id === id);
  expect(i).toBeGreaterThan(-1);
  return [top, i];
}

test('主窗放大 → popout 子窗与新窗口同一级别;重启后保持', async () => {
  test.setTimeout(120_000);
  let { app: a, main } = await launch();
  await main.getByRole('button', { name: SETTINGS }).focus();
  // ⌘= / Ctrl+=(US 键盘不按 Shift 的「放大」键)
  await main.keyboard.press('ControlOrMeta+Equal');
  await expect.poll(() => zoomLevels(a)).toEqual([[false, 1]]);
  // 菜单 显示 → 放大(命令项,与按键同一设置值)
  await clickMenu(a, await menuPathOf(a, VIEW, 'workbench.action.zoomIn'));
  await expect.poll(() => zoomLevels(a)).toEqual([[false, 2]]);

  // 编辑器组弹出到子窗:子窗同一级别
  await main.getByRole('button', { name: DOCK_POPOUT }).first().click();
  await expect.poll(() => a.windows().length, { timeout: 10_000 }).toBe(2);
  await expect.poll(() => zoomLevels(a)).toEqual([
    [false, 2],
    [true, 2],
  ]);

  // 文件 → 新建窗口(⇧⌘N):新窗口同一级别
  await clickMenu(a, [FILE, 0]);
  await expect.poll(() => a.windows().length, { timeout: 15_000 }).toBe(3);
  await expect.poll(() => zoomLevels(a), { timeout: 15_000 }).toEqual([
    [false, 2],
    [true, 2],
    [false, 2],
  ]);

  // 子窗里按缩小:所有窗口一起变
  const child = a.windows().find((w) => w.url().includes('popout=1'))!;
  await child.locator('#dv-popout-window').click();
  await child.keyboard.press('ControlOrMeta+Minus');
  await expect.poll(() => zoomLevels(a)).toEqual([
    [false, 1],
    [true, 1],
    [false, 1],
  ]);

  await a.close();
  app = null;
  ({ app: a, main } = await launch());
  // 重启恢复出的窗口(主窗 / 新窗口 / 子窗)全部为上次的级别
  await expect
    .poll(async () => {
      const levels = await zoomLevels(a);
      return levels.length > 0 && levels.every(([, l]) => l === 1);
    }, { timeout: 15_000 })
    .toBe(true);
});

test('设置页改缩放级别即时作用于所有窗口;恢复默认 / 重置缩放回到 0;命令面板显示默认键', async () => {
  test.setTimeout(90_000);
  const { app: a, main } = await launch();
  await main.getByRole('button', { name: DOCK_POPOUT }).first().click();
  await expect.poll(() => a.windows().length, { timeout: 10_000 }).toBe(2);

  await openSettingsTab(main, GENERAL_TAB);
  const input = main.getByRole('spinbutton', { name: ZOOM_LEVEL_SETTING });
  await expect(input).toBeVisible();
  await input.fill('3');
  await input.press('Enter');
  await expect.poll(() => zoomLevels(a)).toEqual([
    [false, 3],
    [true, 3],
  ]);
  // 越界(> 8)不保存(行内提示范围),各窗口保持;负数级别照常生效
  await input.fill('20');
  await input.press('Enter');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect((await zoomLevels(a)).map(([, l]) => l)).toEqual([3, 3]);
  await input.fill('-1');
  await expect.poll(async () => (await zoomLevels(a)).map(([, l]) => l)).toEqual([-1, -1]);

  // 行内「恢复默认」
  const row = input.locator('xpath=ancestor::div[.//button[@aria-label]][1]');
  await row.getByRole('button', { name: /^(恢复默认|Reset to default|기본값으로 초기화)$/ }).click();
  await expect.poll(() => zoomLevels(a)).toEqual([
    [false, 0],
    [true, 0],
  ]);

  // 命令面板:搜 zoom 找到放大并显示默认键;执行重置缩放回到 0
  await main.evaluate(() => globalThis.__continuoTest!.setSettingValue('window.zoomLevel', 2));
  await expect.poll(async () => (await zoomLevels(a)).map(([, l]) => l)).toEqual([2, 2]);
  await openCommandPalette(main);
  await commandPaletteInput(main).fill('zoom');
  const options = main.getByRole('listbox', { name: COMMAND_LIST }).getByRole('option');
  const zoomIn = options.filter({ hasText: /(放大|Zoom In|확대)/ }).first();
  await expect(zoomIn).toBeVisible();
  expect(await zoomIn.locator('kbd.wm-keycap').count()).toBeGreaterThan(0);
  await expect(options.filter({ hasText: /(重置缩放|Reset Zoom|확대\/축소 초기화)/ })).toHaveCount(1);
  await main.keyboard.press('Escape');
  await expect.poll(() => main.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.zoomReset'))).toBe(true);
  await expect.poll(async () => (await zoomLevels(a)).map(([, l]) => l)).toEqual([0, 0]);
});
