// 无工作区时新建终端:不报红色错误,直接弹出「打开文件夹」对话框并等它完成(Continuo 刻意不回退主目录):选定文件夹 →
// 立即在新文件夹新建终端、不留提示;取消 → info 提示「请先打开一个文件夹」。BDD: src/__tests__/create-user-terminal/
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/electron-app';
import { TERMINAL_INPUT, TERMINAL_PANEL_TAB } from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';

const OPEN_FOLDER_FIRST = /(请先打开一个文件夹|Open a folder first|먼저 폴더를 여세요)/;

test('无工作区 → 新建终端:弹出打开文件夹对话框;取消 → info 提示先打开文件夹', async ({ electronApp, window }) => {
  // 原生对话框换成桩(取消),记录调用次数
  await electronApp.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __openDialogCalls: number };
    g.__openDialogCalls = 0;
    dialog.showOpenDialog = (async () => {
      g.__openDialogCalls += 1;
      return { canceled: true, filePaths: [] };
    }) as typeof dialog.showOpenDialog;
  });

  await dockHeaderMoreActionsButton(window).click();
  const menu = window.getByRole('menu').last();
  await menu.getByRole('menuitem', { name: TERMINAL_TAB }).click();

  // info 级别 toast(非红色 error)
  const toast = window.locator('[data-level]').filter({ hasText: OPEN_FOLDER_FIRST });
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast).toHaveAttribute('data-level', 'info');
  await expect
    .poll(() => electronApp.evaluate(() => (globalThis as unknown as { __openDialogCalls: number }).__openDialogCalls))
    .toBe(1);
});

test('无工作区 → 新建终端 → 对话框选定文件夹:立即在该文件夹新建终端,不留「请先打开文件夹」提示', async ({
  electronApp,
  window,
}) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'continuo-e2e-ws-')));
  try {
    await electronApp.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
    }, dir);

    await dockHeaderMoreActionsButton(window).click();
    const menu = window.getByRole('menu').last();
    await menu.getByRole('menuitem', { name: TERMINAL_TAB }).click();

    await expect(window.getByRole('textbox', { name: TERMINAL_INPUT })).toBeVisible({ timeout: 15_000 });
    await expect(window.locator('[data-level]').filter({ hasText: OPEN_FOLDER_FIRST })).toHaveCount(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 对话框打开期间再按 ⌘T:VSCode 的原生对话框是模态,第二次按键到不了工作台 → 不立即弹「请先打开一个文件夹」、不再调起对话框;
// 选定文件夹后只建 1 个终端。
test('无工作区 → ⌘T 弹出对话框期间再按 ⌘T:不提示、不重复弹框;选定后只建 1 个终端', async ({ electronApp, window }) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'continuo-e2e-ws-')));
  try {
    // 对话框桩:一直开着,直到测试调用 __finishDialog(选定 dir)
    await electronApp.evaluate(({ dialog }, picked) => {
      const g = globalThis as unknown as { __openDialogCalls: number; __finishDialog?: () => void };
      g.__openDialogCalls = 0;
      dialog.showOpenDialog = (() => {
        g.__openDialogCalls += 1;
        return new Promise((resolve) => {
          g.__finishDialog = () => resolve({ canceled: false, filePaths: [picked] });
        });
      }) as typeof dialog.showOpenDialog;
    }, dir);
    const dialogCalls = () =>
      electronApp.evaluate(() => (globalThis as unknown as { __openDialogCalls: number }).__openDialogCalls);

    // 工作台就绪(命令已注册)后再按键
    await expect(dockHeaderMoreActionsButton(window)).toBeVisible({ timeout: 15_000 });
    await window.keyboard.press('ControlOrMeta+t');
    await expect.poll(dialogCalls).toBe(1);
    await window.keyboard.press('ControlOrMeta+t');
    // 给第二次新建走完 IPC 往返的时间:不出提示、不再弹框
    await window.waitForTimeout(1_000);
    await expect(window.locator('[data-level]').filter({ hasText: OPEN_FOLDER_FIRST })).toHaveCount(0);
    expect(await dialogCalls()).toBe(1);

    await electronApp.evaluate(() => (globalThis as unknown as { __finishDialog: () => void }).__finishDialog());
    await expect(window.getByRole('textbox', { name: TERMINAL_INPUT })).toBeVisible({ timeout: 15_000 });
    await window.waitForTimeout(1_000);
    await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(1);
    await expect(window.locator('[data-level]').filter({ hasText: OPEN_FOLDER_FIRST })).toHaveCount(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
