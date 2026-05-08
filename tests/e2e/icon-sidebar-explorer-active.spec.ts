// IconSidebar Explorer 按钮 data-active 同 sidebarOpen 同步.
import { test, expect } from './fixtures/electron-app';

test('Explorer 按钮 data-active=true → 点关 → data-active=false → 再点 → true', async ({
  window,
}) => {
  const btn = window.getByRole('button', { name: /^(显示|隐藏) Explorer$/ }).first();
  await expect(btn).toHaveAttribute('data-active', 'true');

  await btn.click();
  // 现在 sidebarOpen=false → label='显示 Explorer'(active=false)
  const btn2 = window
    .getByRole('button', { name: /^(显示|隐藏) Explorer$/ })
    .first();
  await expect(btn2).toHaveAttribute('data-active', 'false');

  await btn2.click();
  const btn3 = window
    .getByRole('button', { name: /^(显示|隐藏) Explorer$/ })
    .first();
  await expect(btn3).toHaveAttribute('data-active', 'true');
});
