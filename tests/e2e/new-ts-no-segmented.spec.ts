// 新建 .ts 代码文件 → SegmentedControl 不显(autoSaveEnabled=false 路径).
import { test, expect } from './fixtures/with-workspace';

test('新建 hello.ts → 打开 → 显「保存」按钮 + 不显 SegmentedControl', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });
  await window
    .getByRole('menuitem', { name: '新建文件', exact: true })
    .click();

  const input = window.locator('input[placeholder^="新建文件名"]');
  await input.fill('hello.ts');
  await input.press('Enter');

  // 等文件出现 + 自动 reveal/打开?(默认不打开,需要单击)
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: 'hello.ts' }),
  ).toBeVisible({ timeout: 10_000 });
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: 'hello.ts' })
    .first()
    .click();
  await expect(window.locator('header').first()).toContainText('hello.ts');

  // 「保存」按钮存在(disabled 因无脏)
  const main = window.locator('main');
  await expect(
    main.locator('button').filter({ hasText: /^保存$/ }).first(),
  ).toBeVisible();

  // SegmentedControl 不显:Edit / Source / Preview 按钮不可见
  // (SegmentedControl 仅 markdown 时渲染)
  expect(
    await main
      .locator('button, [role=tab]')
      .filter({ hasText: /^Edit$/ })
      .count(),
  ).toBe(0);
});
