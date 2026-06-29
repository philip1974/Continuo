// Quick Open 点击 li 也能打开文件(不只 Enter).
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('单击 Quick Open 列表项 → 打开 + 关闭 modal', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  await input.fill('b.ts');
  const item = window.locator('.wm-modal-content li').first();
  await expect(item).toBeVisible();

  await item.click();

  // modal 关 + b.ts 打开
  await expect(input).toBeHidden();
  await expect(window.locator('header').first()).toContainText('b.ts', {
    timeout: 10_000,
  });
});
