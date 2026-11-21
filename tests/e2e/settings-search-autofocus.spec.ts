// Settings 顶部搜索框 autoFocus(打开 panel 时焦点到 input).
import { test, expect } from './fixtures/electron-app';
import { openSettings, settingsSearch } from './helpers/settings';

test('打开 Settings → 搜索框 autofocus', async ({ window }) => {
  await openSettings(window);
  const search = settingsSearch(window);

  // active element 是搜索 input(autoFocus)
  const focused = await window.evaluate(() => {
    const el = document.activeElement as HTMLInputElement | null;
    return el?.getAttribute('aria-label') ?? null;
  });
  await expect(search).toBeFocused();
  expect(focused).toMatch(/^(搜索设置|Search settings|설정 검색)/);
});
