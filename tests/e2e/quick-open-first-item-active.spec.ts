// Quick Open 默认 selectedIndex=0 → 第一项有 active 底色(bg-hover.text-fg).
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('打开 Quick Open → 第一项 active(.bg-hover)', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });

  const first = window.locator('.wm-modal-content li').first();
  const cls = await first.getAttribute('class');
  expect(cls).toContain('bg-hover');
});
