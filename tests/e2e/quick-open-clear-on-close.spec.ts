// Quick Open: Esc 关闭 + Ctrl+P 重开 → store.open() 重置 query=''.
// (close 自身不动 query;open 才 reset 为空.)
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('Esc 关闭 Quick Open → Ctrl+P 重开 → query 重置为空', async ({
  window,
}) => {
  // 第一次:打开 + 输入 query
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  await input.fill('a.ts');
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts');

  // Esc 关闭
  await window.keyboard.press('Escape');
  await expect(input).toBeHidden();

  // 再开 → store.open() 重置 query='',输入框为空
  await openQuickOpen(window);
  const input2 = quickOpenInput(window);
  await expect(input2).toBeVisible();
  await expect(input2).toHaveValue('');

  await window.keyboard.press('Escape');
});
