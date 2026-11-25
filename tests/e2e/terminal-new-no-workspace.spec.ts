// 无工作区时新建终端:不报红色错误,info 提示「请先打开一个文件夹」并直接弹出「打开文件夹」对话框(Continuo 刻意不回退
// 主目录)。BDD: src/__tests__/create-user-terminal/
import { test, expect } from './fixtures/electron-app';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';

const OPEN_FOLDER_FIRST = /(请先打开一个文件夹|Open a folder first|먼저 폴더를 여세요)/;

test('无工作区 → 新建终端:info 提示先打开文件夹 + 弹出打开文件夹对话框', async ({ electronApp, window }) => {
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
