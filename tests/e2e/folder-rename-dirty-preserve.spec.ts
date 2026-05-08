// dirty src/a.ts + 重命名 src → lib → tab path 同步 prefix + dirty 仍在.
import { test, expect } from './fixtures/with-workspace';

test('dirty src/a.ts → rename src → lib → tab/header 显 a.ts + dirty 保留', async ({
  window,
  workspaceRoot,
}) => {
  void workspaceRoot;
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty');
  await expect(window.locator('span[aria-label="未保存修改"]')).toBeVisible();

  // rename src
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: 'src' })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^重命名/ }).click();
  const input = window.locator('input:focus');
  await input.press('ControlOrMeta+KeyA');
  await input.fill('lib');
  await input.press('Enter');

  // header 显 a.ts(rename 不改 basename)
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 5_000,
  });
  // dirty 仍在(rename 不影响 dirty)
  await expect(window.locator('span[aria-label="未保存修改"]')).toBeVisible();

  // footer span[title] 应反映新 path 含 'lib'
  const titles = await window.locator('footer span[title]').all();
  const allTitles = await Promise.all(
    titles.map((s) => s.getAttribute('title')),
  );
  const matched = allTitles.find((t) => t?.endsWith('a.ts'));
  expect(matched!).toContain('lib');
});
