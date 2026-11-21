// 右键文件 README.md(isFile)→ 菜单不显「新建文件夹」+ 含「复制路径」「复制相对路径」.
import { test, expect } from './fixtures/with-workspace';
import {
  EXPLORER_COPY_PATH,
  EXPLORER_COPY_RELATIVE_PATH,
  EXPLORER_NEW_FOLDER,
  EXPLORER_RENAME,
  EXPLORER_TRASH,
} from './helpers/explorer';

test('右键 README.md → 菜单含 path/重命名/trash,不含「新建文件夹」', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click({ button: 'right' });

  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await expect(
    menu.getByRole('menuitem', { name: EXPLORER_COPY_PATH }),
  ).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: EXPLORER_COPY_RELATIVE_PATH }),
  ).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: EXPLORER_RENAME }),
  ).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: EXPLORER_TRASH }),
  ).toBeVisible();
  // file 模式不显 - 「新建文件」「新建文件夹」(只在 folder / blank 才显)
  await expect(
    menu.getByRole('menuitem', { name: EXPLORER_NEW_FOLDER }),
  ).toHaveCount(0);
});
