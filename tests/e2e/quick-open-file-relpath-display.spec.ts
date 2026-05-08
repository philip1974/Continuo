// Quick Open list item 同时显示 file name + 右侧 relPath(浅色).
import { test, expect } from './fixtures/with-workspace';

test('Quick Open list item 含 file name + relPath', async ({ window }) => {
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
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });

  // src/a.ts 行同时含 'a.ts' name + 'src/a.ts' relPath
  const aRow = window
    .locator('.wm-modal-content li')
    .filter({ hasText: 'a.ts' });
  await expect(aRow).toContainText('a.ts');
  await expect(aRow).toContainText('src/a.ts');
});
