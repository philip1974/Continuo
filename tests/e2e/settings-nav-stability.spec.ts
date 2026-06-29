// Settings nav 反复切换 5+ 次不抛 + 各 tab 主区文案稳定.
import { test, expect } from './fixtures/electron-app';
import { EDITOR_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('循环 nav tab 切换 → 各 tab 内容均渲染', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });

  const tabs = ['通用', '编辑器', '资源管理器', '快捷键', '插件'];
  // 第一次序贯过一遍
  for (const label of tabs) {
    const btn = nav.getByRole('button', { name: label, exact: true });
    if ((await btn.count()) === 0) continue;
    await btn.click();
    // 主区域有 something
    await expect(window.locator('main').first()).toBeVisible();
  }
  // 重复一次,验证状态不腐
  for (const label of tabs) {
    const btn = nav.getByRole('button', { name: label, exact: true });
    if ((await btn.count()) === 0) continue;
    await btn.click();
    await expect(window.locator('main').first()).toBeVisible();
  }

  // 通用 tab 文案
  await nav.getByRole('button', { name: '通用', exact: true }).click();
  await expect(window.locator('main')).toContainText('主题');

  // 编辑器 tab 文案
  await nav.getByRole('button', { name: EDITOR_TAB }).click();
  await expect(window.locator('main')).toContainText('字号');
});
