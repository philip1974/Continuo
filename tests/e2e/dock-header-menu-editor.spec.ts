// Dockview header「More actions」→ 选 Editor:Editor 是单例面板(c94b7006)—— 已开时聚焦已有、不多开第二个
//(两个 EditorPanel 会互相覆盖写盘)。「关掉后从菜单重开」见 BDD header-actions(默认布局下关掉 Editor 会连同其组
// 与 header 菜单一起移除,e2e 不经此入口)。
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/electron-app';
import { DOCK_CLOSE_EDITOR } from './helpers/editor';
import { EXPLORER_MORE_ACTIONS } from './helpers/explorer';
import { EDITOR_TAB } from './helpers/settings';

async function chooseEditorFromMoreActions(window: Page): Promise<void> {
  const moreBtn = window.getByRole('button', { name: EXPLORER_MORE_ACTIONS }).first();
  await expect(moreBtn).toBeVisible({ timeout: 10_000 });
  await moreBtn.click();
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: EDITOR_TAB })).toBeVisible();
  await menu.getByRole('menuitem', { name: EDITOR_TAB }).click();
  await expect(menu).toBeHidden();
}

test('More actions → Editor:Editor 已开时不多开第二个', async ({ window }) => {
  const closeBtns = window.getByRole('button', { name: DOCK_CLOSE_EDITOR });
  await expect(closeBtns).toHaveCount(1, { timeout: 10_000 });

  await chooseEditorFromMoreActions(window);
  await expect(closeBtns).toHaveCount(1);
  await chooseEditorFromMoreActions(window);
  await expect(closeBtns).toHaveCount(1);
});
