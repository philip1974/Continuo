// dirty tab 关闭 ConfirmDialog → ESC → dialog 关 + tab 仍 open + dirty 仍在.
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_CLOSE_A_TS,
  EDITOR_DISCARD_TITLE,
  EDITOR_UNSAVED_CHANGES_SELECTOR,
} from './helpers/editor';

test('dirty + 关 → 弹 ConfirmDialog → ESC → dialog 关 + tab 仍 open', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();

  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty-cancel');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({
    timeout: 5_000,
  });

  await window.getByRole('button', { name: EDITOR_CLOSE_A_TS }).click();
  const dialog = window.locator('.wm-modal-content');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(EDITOR_DISCARD_TITLE);

  // ESC → ConfirmDialog onCancel(Modal 监听 ESC)
  await window.keyboard.press('Escape');

  // dialog 消失
  await expect(dialog).toBeHidden({ timeout: 5_000 });
  // tab 仍开 → header 仍显 a.ts + dirty 圆点仍在
  await expect(window.locator('header').first()).toContainText('a.ts');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible();
});
