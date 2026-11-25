// BDD:src/__tests__/tab-context-menu —— tab 右键菜单(对齐 VSCode)。
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_DONT_SAVE,
  EDITOR_NO_FILE_OPEN,
  EDITOR_SAVE_CHANGES_TITLE,
  EDITOR_TABS,
  EDITOR_UNSAVED_CHANGES_SELECTOR,
} from './helpers/editor';
import { SETTINGS } from './helpers/settings';

const CLOSE_ALL = /^(全部关闭|Close All|모두 닫기)$/;
const CLOSE_OTHERS = /^(关闭其他|Close Others|기타 항목 닫기)$/;

test('编辑器 tab 右键「全部关闭」遇脏文件:先确认,取消则一个都不关;不保存则全部关闭', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const tabs = window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab');
  await expect(tabs).toHaveCount(2, { timeout: 10_000 });

  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({ timeout: 5_000 });

  // 右键 README.md tab → 菜单 → 全部关闭 → a.ts 脏 → 确认框;Esc 取消 → 两个 tab 都还在。
  await tabs.filter({ hasText: 'README.md' }).click({ button: 'right' });
  await window.getByRole('menuitem', { name: CLOSE_ALL }).click();
  const dialog = window.locator('.wm-modal-content');
  await expect(dialog).toContainText(EDITOR_SAVE_CHANGES_TITLE);
  await window.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(tabs).toHaveCount(2);

  // 再来一次选「不保存」→ 全部关闭。
  await tabs.filter({ hasText: 'README.md' }).click({ button: 'right' });
  await window.getByRole('menuitem', { name: CLOSE_ALL }).click();
  await expect(dialog).toBeVisible();
  await dialog.locator('button').filter({ hasText: EDITOR_DONT_SAVE }).click();
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({ timeout: 5_000 });
});

test('dock tab 右键:Shift+F10 打开菜单,「关闭其他」只留当前面板', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await window.getByRole('button', { name: SETTINGS }).click();
  const settingsTab = window.locator('.dv-tab [role=tab]', { hasText: /^(设置|Settings|설정)/ });
  await expect(settingsTab).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('.dv-tab')).toHaveCount(2);

  await settingsTab.focus();
  await window.keyboard.press('Shift+F10');
  await window.getByRole('menuitem', { name: CLOSE_OTHERS }).click();
  await expect(window.locator('.dv-tab')).toHaveCount(1, { timeout: 5_000 });
  await expect(settingsTab).toBeVisible();
});
