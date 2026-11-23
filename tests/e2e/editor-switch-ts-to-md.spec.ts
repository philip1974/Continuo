// 切 file 类型 → 编辑器 UI 同步:.ts 无模式行 / .md 显模式行 SegmentedControl.
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_EDIT, EDITOR_SAVE_LABEL } from './helpers/editor';

test('a.ts 无保存按钮 → 切 README.md → SegmentedControl 出', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts');

  // 先确认代码编辑器已挂载,否定断言才有意义
  await expect(window.locator('.cm-content')).toBeVisible({ timeout: 10_000 });
  // .ts:无模式行(无 Edit 按钮)+ Save 按钮不显
  const main = window.locator('main');
  await expect(
    main.locator('button').filter({ hasText: EDITOR_MODE_EDIT }),
  ).toHaveCount(0);
  await expect(
    window.getByRole('button', { name: EDITOR_SAVE_LABEL }),
  ).toHaveCount(0);

  // 切 README.md
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md');

  // .md:SegmentedControl Edit/Source/Preview 显
  await expect(
    main.locator('button').filter({ hasText: EDITOR_MODE_EDIT }).first(),
  ).toBeVisible({ timeout: 5_000 });
  // Save 按钮不显
  await expect(
    window.getByRole('button', { name: EDITOR_SAVE_LABEL }),
  ).toHaveCount(0);
});
