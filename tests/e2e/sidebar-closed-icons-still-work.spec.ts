// 关闭 Explorer sidebar 后,IconSidebar 其它入口仍可用/可见(齿轮 / Account chip).
import { test, expect } from './fixtures/electron-app';
import type { Page } from '@playwright/test';

const HIDE_EXPLORER = /^(隐藏 Explorer|Hide Explorer|Explorer 숨기기)$/;
const SETTINGS = /^(设置|Settings|설정)$/;
const SETTINGS_NAV = /^(设置分类|Setting categories|설정 카테고리)$/;

async function ensureExplorerSidebarClosed(window: Page): Promise<void> {
  const sidebars = window.locator('main aside');
  if ((await sidebars.count()) > 1) {
    await window.getByRole('button', { name: HIDE_EXPLORER }).click();
  }
  await expect(sidebars).toHaveCount(1, { timeout: 5_000 });
}

test('sidebar 关闭后,设置齿轮仍能打开 SettingsPanel', async ({ window }) => {
  // 关 sidebar
  await ensureExplorerSidebarClosed(window);

  // IconSidebar 仍存在(.w-12 aside),Settings 齿轮仍可点
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(
    window.getByRole('navigation', { name: SETTINGS_NAV }),
  ).toBeVisible({ timeout: 10_000 });
});

test('sidebar 关闭后,AccountChip 仍可见', async ({ window }) => {
  await ensureExplorerSidebarClosed(window);

  const chip = window.getByTitle('Continuo Dev · PRO Plan');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText('CD');
  expect(await chip.evaluate((el) => el.tagName)).not.toBe('BUTTON');
  await expect(chip).not.toHaveAttribute('role', 'button');
  await expect(chip).toBeVisible();
});
