// .md 打开 → 默认 SegmentedControl 显 → autoSave.markdown.enabled=false → SegmentedControl 隐 + Save 按钮显.
import { test, expect } from './fixtures/with-workspace';

test('打开 .md → toggle autoSave.markdown.enabled=false → SegmentedControl 隐 + Save 显', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // 默认:SegmentedControl(Edit)显
  const editBtn = window
    .locator('main')
    .locator('button')
    .filter({ hasText: /^Edit$/ })
    .first();
  await expect(editBtn).toBeVisible();
  // Save 按钮不显
  const saveBtn = window
    .locator('main')
    .locator('button')
    .filter({ hasText: /^保存$/ });
  expect(await saveBtn.count()).toBe(0);

  // 切 setting
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setSettingValue: (id: string, v: boolean) => void;
        };
      }
    ).__continuoTest;
    t.setSettingValue('autoSave.markdown.enabled', false);
  });

  // 等重渲 → SegmentedControl 隐 + Save 按钮显
  await expect(editBtn).toBeHidden({ timeout: 5_000 });
  await expect(
    window.locator('main').locator('button').filter({ hasText: /^保存$/ }).first(),
  ).toBeVisible({ timeout: 5_000 });
});
