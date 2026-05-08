// 右键文件 README.md(isFile)→ 菜单不显「新建文件夹」+ 含「复制路径」「复制相对路径」.
import { test, expect } from './fixtures/with-workspace';

test('右键 README.md → 菜单含 path/重命名/trash,不含「新建文件夹」', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click({ button: 'right' });

  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await expect(menu).toContainText('复制路径');
  await expect(menu).toContainText('复制相对路径');
  await expect(menu).toContainText('重命名');
  await expect(menu).toContainText('移到废纸篓');
  // file 模式不显 - 「新建文件」「新建文件夹」(只在 folder / blank 才显)
  await expect(menu).not.toContainText('新建文件夹');
});
