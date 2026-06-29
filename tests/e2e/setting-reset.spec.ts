// 设置项 reset:改 number setting → reset icon 出现 → 点击恢复 default.
import { test, expect } from './fixtures/electron-app';
import {
  clickFirstVisibleResetDefault,
  EDITOR_TAB,
  resetDefaultButtons,
  SETTINGS,
  SETTINGS_NAV,
  visibleResetDefaultCount,
} from './helpers/settings';

test('字号设置改后 reset 按钮出现 + 点击恢复 default', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  // 切到「编辑器」tab
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
    .click();

  // 找 number input(editor.fontSize 默认 13)
  const fontSizeInput = window.locator('input[type=number]').first();
  await expect(fontSizeInput).toBeVisible();
  await expect(fontSizeInput).toHaveValue('13');

  // 改成 16
  await fontSizeInput.fill('16');
  // 等 store 更新触发重渲
  await expect(fontSizeInput).toHaveValue('16');

  // reset 按钮变可见(原本 invisible class)
  // 同行的 reset IconButton aria-label='恢复默认'
  const resetBtns = resetDefaultButtons(window);
  // 可能有多个 setting item — 找当前行(input 的兄弟)
  // 简化:遍历找第一个 visible class 不含 invisible 的
  const visibleResetCount = await visibleResetDefaultCount(window);
  expect(visibleResetCount).toBeGreaterThan(0);

  // 点同行的 reset
  await resetBtns
    .filter({ has: window.locator('xpath=.') }) // no-op,Locator 链接示意
    .first();
  // 用 evaluate 找到第一个 not-invisible reset 直接 click
  await clickFirstVisibleResetDefault(window);

  // 字号回到 13
  await expect(fontSizeInput).toHaveValue('13');
});
