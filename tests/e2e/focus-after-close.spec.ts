// 关闭弹窗 / tab 后、Explorer 双击文件后焦点归属(VSCode 同款),可直接继续打字。
// BDD: src/__tests__/focus-after-close/、src/__tests__/editor-focus-on-open/
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS } from './helpers/editor';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('焦点在编辑器 → ⌘P 打开 Quick Open → Esc → 焦点回编辑器,可直接键入', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('export const a', { timeout: 10_000 });
  await cm.click();
  await expect(cm).toBeFocused();

  await openQuickOpen(window);
  await expect(quickOpenInput(window)).toBeFocused({ timeout: 5_000 });
  await window.keyboard.press('Escape');
  await expect(window.locator('.wm-modal-content')).toHaveCount(0);

  await expect(cm).toBeFocused();
  await window.keyboard.type('esc-back');
  await expect(cm).toContainText('esc-back');
});

test('三个 tab、焦点在编辑器 → ⌘W 关活动 tab → 直接键入进入新的活动 tab', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await window.locator('text=b.ts').first().click();
  const tabs = window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab');
  await expect(tabs).toHaveCount(3, { timeout: 10_000 });
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('export const b', { timeout: 10_000 });
  await cm.click();

  await window.keyboard.press('ControlOrMeta+w');
  await expect(tabs).toHaveCount(2, { timeout: 5_000 });

  const editable = window.locator('.cm-content, .ProseMirror').first();
  await expect(editable).toBeFocused({ timeout: 5_000 });
  await window.keyboard.type('after-close');
  await expect(editable).toContainText('after-close');
});

test('Explorer 双击文件 → 焦点进编辑器,可直接键入(单击预览焦点仍留在树里)', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().dblclick();
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('export const a', { timeout: 10_000 });
  await expect(cm).toBeFocused({ timeout: 5_000 });
  await window.keyboard.type('dbl');
  await expect(cm).toContainText('dbl');
});
