// Quick Open list item 显示 file name + 右侧所在目录(浅色,VSCode 同款不重复文件名);完整 relPath 在 title.
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('Quick Open list item 含 file name + relPath', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });

  // src/a.ts 行:'a.ts' name + 'src' 目录;完整相对路径 'src/a.ts' 在 title
  const aRow = window
    .locator('.wm-modal-content li')
    .filter({ hasText: 'a.ts' });
  await expect(aRow).toHaveText('a.tssrc');
  await expect(aRow).toHaveAttribute('title', 'src/a.ts');
});
