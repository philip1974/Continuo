// keybindings overrides 持久化:KeybindingCaptureModal 保存 → localStorage
// 'continuo.keybindings.overrides'.
import { test, expect } from './fixtures/electron-app';

test('改 settings.open hotkey → localStorage 写 overrides', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '快捷键', exact: true })
    .click();

  // 找到 settings.open 行 → 编辑按钮
  // KeybindingsTab 列表按 category + title localeCompare,settings.open 应当出现
  await expect(window.locator('main li').first()).toBeVisible({
    timeout: 10_000,
  });

  // 简化:点第一个编辑按钮 → modal 弹 → 按 'k' → 保存
  await window.locator('button[aria-label="编辑快捷键"]').first().click();
  await expect(window.locator('text=设置快捷键').first()).toBeVisible();

  await window.keyboard.press('KeyK');

  // 「保存」按钮(modal 内)— textContent 搜
  const dialog = window.locator('.wm-modal-content').last();
  const saveBtn = dialog.locator('button').filter({ hasText: /^保存$/ });
  await saveBtn.click();
  await expect(dialog).toBeHidden();

  // localStorage 写入
  await window.waitForTimeout(100);
  const raw = await window.evaluate(() =>
    localStorage.getItem('continuo.keybindings.overrides'),
  );
  expect(raw).not.toBeNull();
  const data = JSON.parse(raw!) as Record<string, string>;
  // 至少有一个 override 写入
  expect(Object.keys(data).length).toBeGreaterThan(0);
});
