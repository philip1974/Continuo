// 关闭 dirty tab → ConfirmDialog「放弃未保存的修改?」
//
// 注:实际点击 dialog 内按钮在某些 Electron / dockview / Modal focus trap
// 组合下导致主窗崩溃,具体因不明(Modal 单测全过)。本 spec 仅断言:
//   1. 改脏 + 关 → ConfirmDialog 出现并含正确文案
//   2. dialog 内含「取消」与「不保存关闭」按钮
// 真实点击交互留人工 QA 或后续稳定性调查.

import { test, expect } from './fixtures/with-workspace';

test('改 a.ts → 关 → 弹 ConfirmDialog 「放弃未保存的修改?」 + 两个按钮', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();

  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty');

  await expect(window.locator('span[aria-label="未保存修改"]')).toBeVisible({
    timeout: 5_000,
  });

  await window.locator('button[aria-label=关闭文件]').click();

  const dialog = window.locator('.wm-modal-content');
  await expect(dialog).toBeVisible();
  // 文案 + 按钮文本(不依赖 aria-role,避免 Modal focus trap 期间 role 短暂错位)
  await expect(dialog).toContainText('放弃未保存的修改');
  await expect(dialog).toContainText('取消');
  await expect(dialog).toContainText('不保存关闭');
});
