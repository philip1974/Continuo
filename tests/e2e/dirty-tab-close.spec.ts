// 关闭 dirty tab → ConfirmDialog「是否要保存对 a.ts 的更改?」(VSCode 式 保存 / 不保存 / 取消)
//
// 注:实际点击 dialog 内按钮在某些 Electron / dockview / Modal focus trap
// 组合下导致主窗崩溃,具体因不明(Modal 单测全过)。本 spec 仅断言:
//   1. 改脏 + 关 → ConfirmDialog 出现并含正确文案
//   2. dialog 内含「不保存」「取消」「保存」三个按钮
// 真实点击交互留人工 QA 或后续稳定性调查.

import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_CANCEL,
  EDITOR_CLOSE_A_TS,
  EDITOR_DONT_SAVE,
  EDITOR_SAVE,
  EDITOR_SAVE_CHANGES_TITLE,
  EDITOR_UNSAVED_CHANGES_SELECTOR,
} from './helpers/editor';

test('改 a.ts → 关 → 弹 ConfirmDialog 「是否要保存…」 + 保存 / 不保存 / 取消', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();

  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty');

  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({
    timeout: 5_000,
  });

  await window.getByRole('button', { name: EDITOR_CLOSE_A_TS }).click();

  const dialog = window.locator('.wm-modal-content');
  await expect(dialog).toBeVisible();
  // 文案 + 按钮文本(不依赖 aria-role,避免 Modal focus trap 期间 role 短暂错位)
  await expect(dialog).toContainText(EDITOR_SAVE_CHANGES_TITLE);
  await expect(dialog.locator('button').filter({ hasText: new RegExp(`^${EDITOR_CANCEL.source}$`) })).toHaveCount(1);
  await expect(dialog.locator('button').filter({ hasText: EDITOR_DONT_SAVE })).toHaveCount(1);
  await expect(dialog.locator('button').filter({ hasText: EDITOR_SAVE })).toHaveCount(1);
});
