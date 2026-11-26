// ⌘B 隐藏含焦点的侧栏 → 焦点交给活动编辑器(VSCode),不落 body;再 ⌘B 显示侧栏不抢焦点,仍在编辑区。
// BDD: src/__tests__/explorer-toggle-sidebar/
import { test, expect } from './fixtures/with-workspace';
import type { Page } from '@playwright/test';
import { EDITOR_NO_FILE_OPEN } from './helpers/editor';

/** 焦点所在的工作台区域(data-workbench-part);body / 无焦点 → 'body'。 */
const focusedPart = (window: Page) =>
  window.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return 'body';
    return active.closest('[data-workbench-part]')?.getAttribute('data-workbench-part') ?? 'other';
  });

test('焦点在资源管理器树里按 ⌘B → 侧栏隐藏、焦点进编辑区;再按 ⌘B → 侧栏显示、焦点仍在编辑区', async ({ window }) => {
  const sidebar = window.locator('aside[data-workbench-part="sidebar"]');
  const item = window.getByRole('treeitem', { name: /README\.md/ });
  await expect(item).toBeVisible({ timeout: 10_000 });
  // 编辑器面板内容(lazy)已挂载:树可能先于编辑区渲染出来
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({ timeout: 10_000 });
  await item.focus();
  await expect(item).toBeFocused();

  await window.keyboard.press('ControlOrMeta+b');
  await expect(sidebar).toBeHidden();
  await expect.poll(() => focusedPart(window)).toBe('dock');

  await window.keyboard.press('ControlOrMeta+b');
  await expect(sidebar).toBeVisible();
  await expect.poll(() => focusedPart(window)).toBe('dock');
});
