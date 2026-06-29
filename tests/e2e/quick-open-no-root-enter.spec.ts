// Quick Open 无 root 时打开 → 占位文案 + Enter 不抛.
import { test, expect } from './fixtures/electron-app';
import {
  QUICK_OPEN_NO_WORKSPACE,
  openQuickOpen,
  quickOpenInput,
} from './helpers/palette';

test('无 root + Quick Open + Enter → 不抛 + 占位仍显', async ({
  window,
}) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  await expect(window.locator('.wm-modal-content')).toContainText(
    QUICK_OPEN_NO_WORKSPACE,
  );

  // 没有 list item 也不抛
  await window.keyboard.press('Enter');
  await expect(input).toBeVisible();
});
