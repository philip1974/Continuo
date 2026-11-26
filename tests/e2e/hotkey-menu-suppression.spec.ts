// BDD: src/__tests__/hotkey-menu-suppression —— 菜单开着时不执行工作台快捷键(对齐 VSCode 上下文菜单);「⋯」菜单失焦即关。
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS } from './helpers/editor';
import { explorerMoreActionsButton } from './helpers/explorer';

test('资源管理器右键菜单开着:⌘W 不关背后的编辑器、菜单仍开;Esc 关菜单后 ⌘W 照常', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab')).toHaveCount(2, { timeout: 10_000 });
  // 菜单开着时 Radix 给菜单外节点加 aria-hidden(role 查询看不到 tab),按 DOM 数。
  const tabs = window.locator('[role="tablist"][aria-label] [role="tab"]').filter({ hasText: /README\.md|a\.ts/ });
  await expect(tabs).toHaveCount(2);

  await window.locator('text=README.md').first().click({ button: 'right' });
  const menu = window.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect.poll(() => menu.evaluate((el) => el.contains(el.ownerDocument.activeElement))).toBe(true);

  await window.keyboard.press('ControlOrMeta+w');
  await window.keyboard.press('ControlOrMeta+w');
  await window.waitForTimeout(500);
  await expect(tabs).toHaveCount(2);
  await expect(menu).toBeVisible();

  await window.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await window.locator('.cm-content').click();
  await window.keyboard.press('ControlOrMeta+w');
  await expect(tabs).toHaveCount(1, { timeout: 5_000 });
});

test('资源管理器「⋯」菜单开着:⌘B 不切侧栏、焦点留在菜单;Esc 关闭并还焦点;焦点被移走 → 菜单关闭', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  const sidebar = window.locator('aside[data-workbench-part="sidebar"]');
  const trigger = explorerMoreActionsButton(window);
  const menu = window.getByRole('menu');

  await trigger.click();
  await expect(menu).toBeVisible();
  await expect.poll(() => menu.evaluate((el) => el.contains(el.ownerDocument.activeElement))).toBe(true);
  await window.keyboard.press('ControlOrMeta+B');
  await window.waitForTimeout(300);
  await expect(sidebar).toBeVisible();
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => el.contains(el.ownerDocument.activeElement))).toBe(true);

  await window.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  // 焦点被别处移走(程序聚焦编辑器,不经指针)→ 菜单失焦即关,不再留在屏上。
  await trigger.click();
  await expect(menu).toBeVisible();
  await cm.evaluate((el) => (el as HTMLElement).focus());
  await expect(menu).toBeHidden();
});
