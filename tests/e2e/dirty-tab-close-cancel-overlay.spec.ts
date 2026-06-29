// dirty tab 关闭 ConfirmDialog → 点 overlay 取消 → dialog 关 + tab 仍 open.
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_CLOSE_A_TS,
  EDITOR_UNSAVED_CHANGES_SELECTOR,
} from './helpers/editor';

test('dirty + 关 → 弹 ConfirmDialog → 点 overlay → dialog 关 + tab 仍 open', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();

  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty-overlay');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({
    timeout: 5_000,
  });

  await window.getByRole('button', { name: EDITOR_CLOSE_A_TS }).click();
  const overlay = window.locator('.wm-modal-overlay');
  await expect(overlay).toBeVisible();

  // 点 overlay 角(避开 modal-content)
  await overlay.click({ position: { x: 5, y: 5 } });

  await expect(overlay).toBeHidden({ timeout: 5_000 });
  await expect(window.locator('header').first()).toContainText('a.ts');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible();
});
