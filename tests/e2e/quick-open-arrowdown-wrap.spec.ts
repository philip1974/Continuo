// Cmd+P 列表 N 项 → ArrowDown N 次 → 回到第一项 active(wrap-around).
import { test, expect } from './fixtures/with-workspace';
import { ROW_SELECTED, openQuickOpen, quickOpenInput } from './helpers/palette';

test('3 文件 → ArrowDown 3 次 → 第一项 active', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });

  const items = window.locator('.wm-modal-content li');
  const count = await items.count();
  expect(count).toBeGreaterThanOrEqual(3);

  // ArrowDown 一次 → 第二项选中(证明按键生效)
  await window.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toHaveClass(ROW_SELECTED);
  await expect(items.first()).not.toHaveClass(ROW_SELECTED);

  // 再按 count-1 次(累计 count 次)→ wrap 回第一
  for (let i = 1; i < count; i++) {
    await window.keyboard.press('ArrowDown');
  }
  await expect(items.first()).toHaveClass(ROW_SELECTED);
  await expect(items.nth(1)).not.toHaveClass(ROW_SELECTED);
});
