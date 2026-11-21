// .md 打开 → SegmentedControl 与 autoSave 开关解耦,不显示保存按钮.
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_EDIT,
  EDITOR_SAVE_LABEL,
} from './helpers/editor';

test('打开 .md → 关闭 autoSave 后 SegmentedControl 仍在 + Save 不显', async ({
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
    .filter({ hasText: EDITOR_MODE_EDIT })
    .first();
  await expect(editBtn).toBeVisible();
  // Save 按钮不显
  const saveBtn = window
    .locator('main')
    .locator('button')
    .filter({ hasText: EDITOR_SAVE_LABEL });
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

  // 等重渲 → SegmentedControl 仍在,Save 按钮仍不显.
  await expect(editBtn).toBeVisible({ timeout: 5_000 });
  await expect(
    window.getByRole('button', { name: EDITOR_SAVE_LABEL }),
  ).toHaveCount(0);
});
