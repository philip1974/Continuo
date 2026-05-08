// HeaderActions popout button:activePanel=null 时 disabled.
// 默认 layout 有 Editor panel + 它是 active,popout 应 enabled.
// 关闭 Editor panel → activePanel=null → popout disabled.
import { test, expect } from './fixtures/electron-app';

test('默认 layout(Editor active)→ popout 按钮 enabled', async ({
  window,
}) => {
  const popout = window.locator(
    'button[aria-label="Pop out active panel"]',
  );
  await expect(popout).toBeVisible({ timeout: 10_000 });
  await expect(popout).toBeEnabled();
});

test('关闭 Editor → EmptyState → popout 按钮也消失(连 HeaderActions 一并)', async ({
  window,
}) => {
  await window.locator('button[aria-label="Close Editor"]').click();
  await window.waitForTimeout(400);

  // EmptyState 顶替 dock,HeaderActions(在 dockview group header 内)不再渲染
  await expect(
    window.locator('button[aria-label="Pop out active panel"]'),
  ).toHaveCount(0);
});
