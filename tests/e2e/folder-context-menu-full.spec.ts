// 右键 src(folder)→ ContextMenu 含完整项目:创建 / 重命名 / 移到废纸篓.
import { test, expect } from './fixtures/with-workspace';
import {
  EXPLORER_COPY,
  EXPLORER_CUT,
  EXPLORER_NEW_FILE,
  EXPLORER_NEW_FOLDER,
  EXPLORER_RENAME,
  EXPLORER_TRASH,
} from './helpers/explorer';

test('右键 src → 菜单含「新建文件 / 新建文件夹 / 重命名 / 移到废纸篓 / 复制 / 剪切」', async ({
  window,
}) => {
  await window.locator('text=src').first().click({ button: 'right' });

  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await expect(
    menu.getByRole('menuitem', { name: EXPLORER_NEW_FILE }),
  ).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: EXPLORER_NEW_FOLDER }),
  ).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: EXPLORER_RENAME }),
  ).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: EXPLORER_TRASH }),
  ).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: EXPLORER_CUT })).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: EXPLORER_COPY }),
  ).toBeVisible();
});
