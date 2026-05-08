// 右键 src(folder)→ ContextMenu 含完整项目:创建 / 重命名 / 移到废纸篓.
import { test, expect } from './fixtures/with-workspace';

test('右键 src → 菜单含「新建文件 / 新建文件夹 / 重命名 / 移到废纸篓 / 复制 / 剪切」', async ({
  window,
}) => {
  await window.locator('text=src').first().click({ button: 'right' });

  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await expect(menu).toContainText('新建文件');
  await expect(menu).toContainText('新建文件夹');
  await expect(menu).toContainText('重命名');
  await expect(menu).toContainText('移到废纸篓');
  await expect(menu).toContainText('剪切');
  await expect(menu).toContainText('复制');
});
