// 代码编辑器 Tab 缩进 / Esc+Tab 移出;F6 / ⇧F6 在 dock 组 / 状态栏 / 侧栏间循环(VSCode 同)。
// BDD: src/__tests__/keyboard-focus-parity/
import { test, expect } from './fixtures/with-workspace';

test('代码编辑器:Tab 缩进、⇧Tab 反缩进,焦点留在编辑器;Esc 后 Tab 移出编辑器', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().dblclick();
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('export const a', { timeout: 10_000 });
  await expect(cm).toBeFocused({ timeout: 5_000 });
  await window.keyboard.press('ControlOrMeta+Home');

  await window.keyboard.press('Tab');
  await expect(cm).toBeFocused();
  await expect(window.locator('.cm-line').first()).toHaveText(/^\s+export const a/);
  await window.keyboard.press('Shift+Tab');
  await expect(window.locator('.cm-line').first()).toHaveText(/^export const a/);

  await window.keyboard.press('Escape');
  await window.keyboard.press('Tab');
  await expect(cm).not.toBeFocused();
  await expect(window.locator('.cm-line').first()).toHaveText(/^export const a/);
});

test('编辑器里 F6 → 状态栏 → 侧栏(Explorer 树)→ 回编辑器;⇧F6 反向', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().dblclick();
  const cm = window.locator('.cm-content');
  await expect(cm).toContainText('export const a', { timeout: 10_000 });
  await expect(cm).toBeFocused({ timeout: 5_000 });

  const inPart = (part: string) =>
    window.evaluate((p) => Boolean(document.activeElement?.closest(`[data-workbench-part="${p}"]`)), part);

  await window.keyboard.press('F6');
  await expect.poll(() => inPart('statusbar')).toBe(true);
  await window.keyboard.press('F6');
  await expect.poll(() => inPart('sidebar')).toBe(true);
  await expect(window.locator(':focus')).toHaveAttribute('role', 'treeitem');
  await window.keyboard.press('F6');
  await expect(cm).toBeFocused();

  await window.keyboard.press('Shift+F6');
  await expect.poll(() => inPart('sidebar')).toBe(true);
  await window.keyboard.press('Shift+F6');
  await expect.poll(() => inPart('statusbar')).toBe(true);
  await window.keyboard.press('Shift+F6');
  await expect(cm).toBeFocused();
});
