// 设置项右键 / 「更多操作」菜单(VSCode settingsTree settingActions,BDD: src/__tests__/list-context-menus/):
// 右键 / Shift+F10 / 齿轮按钮打开、复制设置 ID(读剪贴板)、重置设置、Esc 焦点回到原处。
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/electron-app';
import { EDITOR_TAB, openSettingsTab } from './helpers/settings';

const RESET_SETTING = /^(重置设置|Reset Setting|설정 초기화)$/;
const COPY_ID = /^(复制设置 ID|Copy Setting ID|설정 ID 복사)$/;
const COPY_JSON = /^(将设置复制为 JSON|Copy Setting as JSON|설정을 JSON으로 복사)$/;
const MORE_ACTIONS = /(的更多操作|More actions for|기타 작업)/;

test.beforeEach(async ({ window }) => {
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
});

const row = (window: Page, id: string) => window.locator(`[data-setting-row="${id}"]`);

test('右键设置项 → 复制设置 ID 写入剪贴板;改值后右键「重置设置」回到默认', async ({ window, electronApp }) => {
  await openSettingsTab(window, EDITOR_TAB);
  const lineNumbers = row(window, 'editor.lineNumbers');
  await expect(lineNumbers).toBeVisible({ timeout: 10_000 });

  await lineNumbers.locator('span').first().click({ button: 'right' });
  const menu = window.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText([RESET_SETTING, COPY_ID, COPY_JSON]);
  await expect(menu.getByRole('menuitem', { name: RESET_SETTING })).toHaveAttribute('aria-disabled', 'true');
  await menu.getByRole('menuitem', { name: COPY_ID }).click();
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
    .toBe('editor.lineNumbers');

  const sw = lineNumbers.getByRole('switch');
  const before = await sw.getAttribute('aria-checked');
  await sw.click();
  await expect(sw).not.toHaveAttribute('aria-checked', before!);
  await lineNumbers.locator('span').first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: RESET_SETTING }).click();
  await expect(menu).toHaveCount(0);
  await expect(sw).toHaveAttribute('aria-checked', before!);
});

test('控件聚焦时 Shift+F10 → 菜单定位在「更多操作」按钮处;Esc → 焦点回到控件;齿轮按钮点击同样打开', async ({ window }) => {
  await openSettingsTab(window, EDITOR_TAB);
  const lineNumbers = row(window, 'editor.lineNumbers');
  await expect(lineNumbers).toBeVisible({ timeout: 10_000 });
  const sw = lineNumbers.getByRole('switch');
  await sw.focus();
  const more = lineNumbers.getByRole('button', { name: MORE_ACTIONS });
  // 行内有焦点 → 齿轮显示
  await expect.poll(() => more.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

  // 按钮位置在打开前取:菜单打开期间 Radix 给菜单外节点加 aria-hidden(模态),按角色查不到
  const btnBox = (await more.boundingBox())!;
  await window.keyboard.press('Shift+F10');
  const menu = window.getByRole('menu');
  await expect(menu).toBeVisible();
  const menuBox = (await menu.boundingBox())!;
  expect(Math.abs(menuBox.y - (btnBox.y + btnBox.height))).toBeLessThan(40);
  await window.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(sw).toBeFocused();

  await more.click();
  await expect(menu.getByRole('menuitem', { name: COPY_JSON })).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
});
