// 编辑 a.ts → Cmd+S → dirty 圆点消失 + TitleBar ● 消失.
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_UNSAVED_CHANGES_SELECTOR } from './helpers/editor';

test('编辑 + Cmd+S → dirty / TitleBar ● 都消失', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // edit');

  // dirty 圆点出现
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible();
  await expect(window.locator('header').first()).toContainText('●');

  // Cmd+S
  await cm.press('ControlOrMeta+KeyS');

  // dirty 消失
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeHidden({
    timeout: 5_000,
  });
  // TitleBar ● 消失
  const titleText = await window.locator('header').first().textContent();
  expect(titleText).not.toContain(' ●');
});
