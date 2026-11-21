// Settings 搜索大小写不敏感.
import { test, expect } from './fixtures/electron-app';
import { openSettings, settingsSearch } from './helpers/settings';

test('FONTSIZE / fontsize 都匹配 editor.fontSize', async ({ window }) => {
  await openSettings(window);
  const search = settingsSearch(window);

  for (const q of ['FONTSIZE', 'fontsize', 'FoNtSiZe']) {
    await search.fill(q);
    await expect(
      window.locator('main code').filter({ hasText: 'editor.fontSize' }),
    ).toBeVisible({ timeout: 3_000 });
  }
});
