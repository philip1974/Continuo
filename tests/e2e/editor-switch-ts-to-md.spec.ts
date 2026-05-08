// 切 file 类型 → EditorHeader UI 同步:.ts 显「保存」/.md 显 SegmentedControl.
import { test, expect } from './fixtures/with-workspace';

test('a.ts 显「保存」 → 切 README.md → SegmentedControl 出', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts');

  // .ts:Save 按钮显
  const main = window.locator('main');
  const saveBtn = main.locator('button').filter({ hasText: /^保存$/ }).first();
  await expect(saveBtn).toBeVisible();

  // 切 README.md
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md');

  // .md:SegmentedControl Edit/Source/Preview 显
  await expect(
    main.locator('button').filter({ hasText: /^Edit$/ }).first(),
  ).toBeVisible({ timeout: 5_000 });
  // Save 按钮不显
  expect(
    await main.locator('button').filter({ hasText: /^保存$/ }).count(),
  ).toBe(0);
});
