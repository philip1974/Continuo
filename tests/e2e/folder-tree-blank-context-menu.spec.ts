// 右键 FolderTree 空白区(target=null)→ 菜单只含创建项,不含 rename/trash.
import { test, expect } from './fixtures/with-workspace';

test('右键空白 → 菜单含「新建文件/新建文件夹」+ 不含「重命名/移到废纸篓」', async ({
  window,
}) => {
  // FolderTree scroll 区:`main aside .nth(1)` 内的滚动 div(items 已渲染)
  const aside = window.locator('main aside').nth(1);
  await expect(aside.locator('text=README.md').first()).toBeVisible();

  // 取 scroll 区底部空白点(高度足够 README/src 之外)
  const scroll = aside.locator('.overflow-auto.bg-canvas').first();
  const box = await scroll.boundingBox();
  if (!box) throw new Error('scroll box missing');
  // 在底部 80% 处右键(避开 row)
  await scroll.click({
    button: 'right',
    position: { x: box.width / 2, y: Math.max(box.height - 30, box.height * 0.8) },
  });

  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await expect(menu).toContainText('新建文件');
  await expect(menu).toContainText('新建文件夹');
  // blank 模式不显
  await expect(menu).not.toContainText('重命名');
  await expect(menu).not.toContainText('移到废纸篓');
});
