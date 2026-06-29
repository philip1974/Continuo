// Quick Open fuzzy 匹配大小写不敏感.
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('全大写 README.MD 匹配 README.md', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  await expect(window.locator('.wm-modal-content')).toContainText(
    'README.md',
    { timeout: 10_000 },
  );

  await input.fill('README.MD'); // 全大写
  await expect(window.locator('.wm-modal-content')).toContainText(
    'README.md',
  );
});

test('全小写 readme 匹配 README.md', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  await expect(window.locator('.wm-modal-content')).toContainText(
    'README.md',
    { timeout: 10_000 },
  );
  await input.fill('readme');
  await expect(window.locator('.wm-modal-content')).toContainText(
    'README.md',
  );
});
