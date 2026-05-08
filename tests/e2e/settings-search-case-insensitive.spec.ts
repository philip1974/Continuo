// Settings 搜索大小写不敏感.
import { test, expect } from './fixtures/electron-app';

test('CODEEDITOR / codeeditor 都匹配 editor.fontSize', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });

  const search = window.locator('input[placeholder*="搜索设置"]');

  for (const q of ['CODEEDITOR', 'codeeditor', 'CoDeEdiTor']) {
    await search.fill(q);
    await expect(
      window.locator('main code').filter({ hasText: 'editor.fontSize' }),
    ).toBeVisible({ timeout: 3_000 });
  }
});
