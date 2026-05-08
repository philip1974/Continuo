// 编辑快捷键 modal 的捕获行为:Backspace = unbind,任何键 = 新组合,
// 重置默认 / 保存按钮.
import { test, expect } from './fixtures/electron-app';

async function openCaptureForFirstCommand(
  window: import('@playwright/test').Page,
): Promise<void> {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '快捷键', exact: true })
    .click();
  await expect(window.locator('main li').first()).toBeVisible({
    timeout: 10_000,
  });
  await window.locator('button[aria-label="编辑快捷键"]').first().click();
  await expect(window.locator('text=设置快捷键').first()).toBeVisible();
}

test('打开编辑 modal → 输入 Backspace → 「未绑定」', async ({
  window,
}) => {
  await openCaptureForFirstCommand(window);
  const dialog = window.locator('.wm-modal-content').last();

  // 初始可能显当前 hotkey(currentHotkey),也可能显「按下新组合…」(无默认).
  // 不假设初始态,直接 Backspace → captured='' → dialog 显「未绑定」.
  await window.keyboard.press('Backspace');
  await expect(dialog).toContainText('未绑定');
});

test('编辑 modal:输入新组合 + 三个底部按钮可见', async ({ window }) => {
  await openCaptureForFirstCommand(window);
  const dialog = window.locator('.wm-modal-content').last();

  // 按 'k' → captured='k';dialog 内 capture 区 KeyCap 含 'K' 字符.
  // 注意 dialog 内还有 Backspace / Esc 两个提示 KeyCap,总数 ≥ 3.
  await window.keyboard.press('KeyK');
  expect(await dialog.locator('kbd.wm-keycap').count()).toBeGreaterThanOrEqual(
    3,
  );

  // 三个底部按钮文本可见
  await expect(dialog).toContainText('取消');
  await expect(dialog).toContainText('保存');
  await expect(dialog).toContainText('重置默认');
});
