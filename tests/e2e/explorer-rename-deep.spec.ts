// 改一个文件夹名 → 内部已打开的 tab 路径 prefix 同步重写.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('打开 src/a.ts → 重命名 src 为 lib → 文件路径同步 + tab 路径同步', async ({
  window,
  workspaceRoot,
}) => {
  // 展开 + 打开 src/a.ts
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 10_000,
  });

  // 右键 src 行(treeitem 限定避免 StatusBar / TitleBar 同名)
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: 'src' })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^重命名/ }).click();

  const input = window.locator('input:focus');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.press('ControlOrMeta+KeyA');
  await input.fill('lib');
  await input.press('Enter');

  // 磁盘:lib/a.ts 存在 + src 不存在
  await expect(async () => {
    await stat(path.join(workspaceRoot, 'lib/a.ts'));
  }).toPass({ timeout: 5_000 });

  const oldExists = await stat(path.join(workspaceRoot, 'src'))
    .then(() => true)
    .catch(() => false);
  expect(oldExists).toBe(false);

  // editor.store.renamePath 同步 a.ts tab 的 filePath:'/...lib/a.ts'.
  // StatusBar 右侧 active file span 的 title 属性 = filePath,验证含 'lib' 路径.
  const fileTitles = await window.locator('footer span[title]').all();
  const titles = await Promise.all(
    fileTitles.map((s) => s.getAttribute('title')),
  );
  const matched = titles.find((t) => t?.endsWith('a.ts'));
  expect(matched).toBeDefined();
  expect(matched!).toContain('lib');
  expect(matched!).not.toContain('/src/');
});
