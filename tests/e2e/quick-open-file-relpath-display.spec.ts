// Quick Open list item 同时显示 file name + 右侧 relPath(浅色).
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('Quick Open list item 含 file name + relPath', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
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
