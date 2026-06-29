// 无 active tab(EditorWelcome)→ EditorHeader 不渲染 → 没有 mode SegmentedControl.
import { test, expect } from './fixtures/electron-app';
import { EDITOR_NO_FILE_OPEN } from './helpers/editor';

test('无 tab → 不显「保存」按钮 + 不显 SegmentedControl', async ({
  window,
}) => {
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({
    timeout: 10_000,
  });

  const main = window.locator('main');
  // 没 SegmentedControl
  expect(
    await main
      .locator('button, [role=tab]')
      .filter({ hasText: /^Edit$/ })
      .count(),
  ).toBe(0);
  // 没「保存」按钮(EditorHeader tabs=0 时返 null)
  expect(
    await main.locator('button').filter({ hasText: /^保存$/ }).count(),
  ).toBe(0);
});
