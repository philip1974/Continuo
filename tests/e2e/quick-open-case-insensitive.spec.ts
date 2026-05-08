// Quick Open fuzzy 匹配大小写不敏感.
import { test, expect } from './fixtures/with-workspace';

test('全大写 README.MD 匹配 README.md', async ({ window }) => {
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input = window.locator(
    '.wm-modal-content input[placeholder*="搜索文件名"]',
  );
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
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input = window.locator(
    '.wm-modal-content input[placeholder*="搜索文件名"]',
  );
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
