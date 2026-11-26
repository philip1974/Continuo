// BDD:src/__tests__/dock-reset-layout —— 「视图:重置布局」不合并编辑器组:⌘\ 拆成两组后执行,两组仍左右分栏(不叠成同一
// dock 组里的两个「编辑器」tab);第二个组的 dock 标题带编号「编辑器 2」(src/__tests__/editor-groups/)。
import { test, expect } from './fixtures/with-workspace';
import { COMMAND_LIST, commandPaletteInput, openCommandPalette } from './helpers/palette';

const EDITOR_2_TAB = /^(编辑器 2|Editor 2|편집기 2)/;

test('⌘\\ 拆两组后「重置布局」→ 两个编辑器组仍左右分栏并都可见;第二组 dock 标题「编辑器 2」', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const groups = window.locator('[data-editor-panel-root]');
  await expect(groups.first().locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });
  await groups.first().locator('.cm-content').click();
  await window.keyboard.press('ControlOrMeta+Backslash');
  await expect(groups).toHaveCount(2, { timeout: 10_000 });
  await expect(window.locator('.dv-tab [role=tab]', { hasText: EDITOR_2_TAB })).toHaveCount(1);

  await openCommandPalette(window);
  await commandPaletteInput(window).fill('Reset Layout');
  const option = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: /(重置布局|Reset Layout|레이아웃 초기화)/ });
  await expect(option).toHaveCount(1);
  await option.click();

  // 两组都可见(叠成同组 tab 时只有活动的那个可见),且左右并排
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toBeVisible();
  await expect(groups.nth(1)).toBeVisible();
  const [left, right] = await Promise.all([groups.nth(0).boundingBox(), groups.nth(1).boundingBox()]);
  expect(left && right && Math.abs(left.x - right.x) > 50).toBe(true);
});
