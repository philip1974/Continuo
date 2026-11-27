// 快捷键页行右键菜单(VSCode keybindingsEditor onContextMenu,BDD: src/__tests__/list-context-menus/):右键 / Shift+F10 打开、
// 删除快捷键 → 未绑定、重置快捷键 → 恢复默认、Esc 焦点回到原处。
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/electron-app';
import { KEYBINDINGS_TAB, openSettingsTab } from './helpers/settings';
import { waitForTestHooks } from './helpers/app-ready';

const REMOVE = /^(删除快捷键|Remove Hotkey|단축키 제거)$/;
const RESET = /^(重置快捷键|Reset Hotkey|단축키 초기화)$/;
const CHANGE = /^(更改快捷键…|Change Hotkey…|단축키 변경…)$/;
const COPY_ID = /^(复制命令 ID|Copy Command ID|명령 ID 복사)$/;
const UNBOUND = /(未绑定|Unbound|바인딩 없음)/;

test.beforeEach(async ({ window }) => {
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
});

const row = (window: Page, id: string) => window.locator(`[data-keybinding-row="${id}"]`);

test('右键「删除快捷键」→ 未绑定;右键「重置快捷键」→ 恢复默认键', async ({ window, electronApp }) => {
  await waitForTestHooks(window);
  await openSettingsTab(window, KEYBINDINGS_TAB);
  const settingsRow = row(window, 'settings.toggle');
  await expect(settingsRow).toBeVisible({ timeout: 10_000 });
  const keys = settingsRow.getByTestId('keybinding-keys');
  await expect(keys).toBeVisible();

  await settingsRow.locator('span').first().click({ button: 'right' });
  const menu = window.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: CHANGE })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: RESET })).toHaveAttribute('aria-disabled', 'true');
  await menu.getByRole('menuitem', { name: COPY_ID }).click();
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
    .toBe('settings.toggle');

  await settingsRow.locator('span').first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: REMOVE }).click();
  await expect(menu).toHaveCount(0);
  await expect(settingsRow).toContainText(UNBOUND);
  await expect(keys).toHaveCount(0);

  await settingsRow.locator('span').first().click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: REMOVE })).toHaveAttribute('aria-disabled', 'true');
  await menu.getByRole('menuitem', { name: RESET }).click();
  await expect(menu).toHaveCount(0);
  await expect(keys).toBeVisible();
});

test('行内编辑按钮聚焦时 Shift+F10 → 该行菜单;Esc → 焦点回到该按钮', async ({ window }) => {
  await openSettingsTab(window, KEYBINDINGS_TAB);
  const settingsRow = row(window, 'settings.toggle');
  await expect(settingsRow).toBeVisible({ timeout: 10_000 });
  const edit = settingsRow.locator('[data-keybinding-edit]');
  await edit.focus();
  await window.keyboard.press('Shift+F10');
  const menu = window.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: CHANGE })).toBeVisible();
  const btnBox = (await edit.boundingBox())!;
  const menuBox = (await menu.boundingBox())!;
  expect(Math.abs(menuBox.y - (btnBox.y + btnBox.height))).toBeLessThan(40);
  await window.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(edit).toBeFocused();
});
